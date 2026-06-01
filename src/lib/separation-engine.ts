// 분리 엔진 (메인 스레드 인터페이스).
// 무거운 STFT+ONNX 추론은 Web Worker(separation-worker)에서 수행.
// 출력: { drumsBuffer, backingBuffer } 두 AudioBuffer — 3단계 재생 엔진
// audio-engine 의 입력과 그대로 맞물린다(에셋 비의존 설계).
// 2차-8: 메인 thread 는 WebGPU 가용성(navigator.gpu/adapter) 판별 + 백엔드
// 결정 영속화(localStorage)만 담당하고, 실제 추론·벤치마크·MSE 는 worker.
import type { BackendName } from "./separation-backend";

export type SeparationResult = {
  drumsBuffer: AudioBuffer;
  backingBuffer: AudioBuffer;
};

export type Pcm = {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
};

/** 분리 백엔드 상태 — UI 의 "가속 준비 중…"/가속 태그 표시용. */
export type BackendStatus =
  | { phase: "preparing" }
  | { phase: "running"; backend: BackendName };

type DoneMsg = {
  type: "done";
  drumsL: Float32Array;
  drumsR: Float32Array;
  backingL: Float32Array;
  backingR: Float32Array;
  length: number;
  sampleRate: number;
};
type ProgressMsg = { type: "progress"; chunk: number; total: number };
type PreparingMsg = { type: "preparing" };
type BackendMsg = {
  type: "backend";
  name: BackendName;
  source: "forced" | "benchmark" | "default" | "fallback";
  metrics?: { tWasm: number; tGpu: number; mse: number };
};
type ErrorMsg = { type: "error"; message: string };
type OutMsg = DoneMsg | ProgressMsg | PreparingMsg | BackendMsg | ErrorMsg;

// ── WebGPU adapter 판별 (최소 타입; @webgpu/types 의존 회피) ───────────────
type GpuAdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};
type GpuAdapter = {
  info?: GpuAdapterInfo;
  requestAdapterInfo?: () => Promise<GpuAdapterInfo>;
};
type MinimalGpu = { requestAdapter: () => Promise<GpuAdapter | null> };

// v2: 벤치마크 알고리즘 정정(공정 측정+보수 마진). 키가 바뀌어 이전(v1)의
// 잘못된 WebGPU 락 영속화가 자동 무효화되고 재벤치마크된다. bench 스탬프도
// 키에 포함해, 이후 벤치마크 로직이 또 바뀌면 동일하게 자동 무효화.
const BACKEND_KEY_PREFIX = "dr-backend-v2";
const ORT_STAMP = "ort1.26";
const MODEL_STAMP = "htdemucs-v1";
const BENCH_STAMP = "bench2-fair-margin1.3";

type BackendDecision = {
  forced: BackendName | null; // 영속 결정이 있으면 worker 가 벤치마크 스킵
  persistKey: string | null; // GPU 환경 변화 시 자동 재벤치마크되는 키
  webgpuAvailable: boolean;
};

/**
 * 백엔드 결정. navigator.gpu/adapter 가 없으면 WASM 고정(벤치마크 불필요).
 * adapter 가 있으면 영속화 키 = {webgpu유무 + GPU adapter 식별자 + ort/모델
 * 스탬프} — GPU 가 바뀌면 키가 바뀌어 자동 재벤치마크. 저장된 결정이 있으면
 * forced 로 worker 에 전달(벤치마크 1회만, 이후 즉시).
 */
async function resolveBackend(): Promise<BackendDecision> {
  const gpu = (navigator as unknown as { gpu?: MinimalGpu }).gpu;
  if (!gpu) return { forced: "wasm", persistKey: null, webgpuAvailable: false };

  let adapterId = "present";
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { forced: "wasm", persistKey: null, webgpuAvailable: false };
    }
    let info: GpuAdapterInfo | null = adapter.info ?? null;
    if (!info && typeof adapter.requestAdapterInfo === "function") {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        info = null;
      }
    }
    if (info) {
      const id = [info.vendor, info.architecture, info.device, info.description]
        .filter(Boolean)
        .join("|");
      if (id) adapterId = id;
    }
  } catch {
    // requestAdapter 자체가 throw → WebGPU 사용 불가로 간주, WASM
    return { forced: "wasm", persistKey: null, webgpuAvailable: false };
  }

  const persistKey = `${BACKEND_KEY_PREFIX}::${adapterId}::${ORT_STAMP}::${MODEL_STAMP}::${BENCH_STAMP}`;
  let forced: BackendName | null = null;
  try {
    const saved = localStorage.getItem(persistKey);
    if (saved === "wasm" || saved === "webgpu") forced = saved;
  } catch {
    // localStorage 불가(프라이버시 모드 등) → in-memory 폴백(이번 세션만 벤치마크)
  }
  return { forced, persistKey, webgpuAvailable: true };
}

function persistDecision(key: string, name: BackendName): void {
  try {
    localStorage.setItem(key, name);
  } catch {
    /* localStorage 불가 — 무시(다음 세션 재벤치마크) */
  }
}

function toBuffer(
  ctx: BaseAudioContext,
  l: Float32Array,
  r: Float32Array,
  sampleRate: number,
): AudioBuffer {
  const buf = ctx.createBuffer(2, l.length, sampleRate);
  buf.getChannelData(0).set(l);
  buf.getChannelData(1).set(r);
  return buf;
}

/** 디코드된 스테레오 PCM 을 drums/backing 두 트랙으로 분리. */
export async function separate(
  pcm: Pcm,
  modelBytes: ArrayBuffer,
  opts: {
    onProgress?: (chunk: number, total: number) => void;
    onStatus?: (s: BackendStatus) => void;
    audioContext?: BaseAudioContext;
  } = {},
): Promise<SeparationResult> {
  if (typeof window === "undefined") {
    throw new Error("separate() is browser-only");
  }
  // 백엔드 결정은 worker 생성 전에 메인 thread 에서(navigator.gpu/localStorage).
  const decision = await resolveBackend();

  return new Promise<SeparationResult>((resolve, reject) => {
    const worker = new Worker(
      new URL("./separation-worker.ts", import.meta.url),
      { type: "module" },
    );
    const ctx = opts.audioContext ?? new AudioContext();

    worker.onmessage = (e: MessageEvent<OutMsg>) => {
      const m = e.data;
      if (m.type === "preparing") {
        opts.onStatus?.({ phase: "preparing" });
      } else if (m.type === "backend") {
        opts.onStatus?.({ phase: "running", backend: m.name });
        // 벤치마크/폴백으로 새로 정해진 결정만 영속화(forced/default 는 재기록 불필요).
        if (
          decision.persistKey &&
          (m.source === "benchmark" || m.source === "fallback")
        ) {
          persistDecision(decision.persistKey, m.name);
        }
        try {
          // 외부 점검자가 어떤 백엔드로 돌았는지 보고하기 쉽게(에러 아님, info).
          console.info("[drum-room] 분리 백엔드:", m.name, m.metrics ?? "");
        } catch {
          /* noop */
        }
      } else if (m.type === "progress") {
        opts.onProgress?.(m.chunk, m.total);
      } else if (m.type === "done") {
        const drumsBuffer = toBuffer(ctx, m.drumsL, m.drumsR, m.sampleRate);
        const backingBuffer = toBuffer(
          ctx,
          m.backingL,
          m.backingR,
          m.sampleRate,
        );
        worker.terminate();
        resolve({ drumsBuffer, backingBuffer });
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || "separation worker error"));
    };

    // modelBytes 는 transfer 하면 호출부에서 재사용 불가 → 복사본 전달
    worker.postMessage(
      {
        modelBytes,
        left: pcm.left,
        right: pcm.right,
        sampleRate: pcm.sampleRate,
        forcedBackend: decision.forced,
        webgpuAvailable: decision.webgpuAvailable,
      },
      [pcm.left.buffer, pcm.right.buffer],
    );
  });
}

const TARGET_SR = 44100;

/**
 * 디코드 단계 실패 전용 에러. SeparatingView 가 "어느 단계 실패인지"를
 * 메시지 문자열 추측(/Failed to/ 등)이 아니라 이 타입으로 정확히 가른다
 * — 회귀(2차-1)에서 worker/ort 에러가 디코드 에러로 오분류된 재발 방지.
 */
export class AudioDecodeError extends Error {
  readonly code = "AUDIO_DECODE" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AudioDecodeError";
  }
}

/**
 * 모델은 44100Hz 입력을 기대한다. 디바이스 AudioContext 의 sampleRate(예: 48000)
 * 로 decodeAudioData 하면 리샘플돼 모델 입력이 어긋난다(검증에서 cos≈0 로 발견).
 * → OfflineAudioContext(44100) 로 디코드해 항상 정확히 44100 PCM 을 얻는다.
 * 임의 SR 의 사용자 곡도 브라우저가 44100 으로 리샘플해준다.
 */
export async function decodeAudioFile(file: ArrayBuffer): Promise<Pcm> {
  const OAC: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const oac = new OAC(2, 1, TARGET_SR);
  let decoded: AudioBuffer;
  try {
    decoded = await oac.decodeAudioData(file.slice(0));
  } catch (e) {
    // 디코드 실패만 "파일 못 엶"으로 분류되도록 단계 표식을 붙인다.
    throw new AudioDecodeError(e);
  }
  const left = new Float32Array(decoded.getChannelData(0));
  const right =
    decoded.numberOfChannels > 1
      ? new Float32Array(decoded.getChannelData(1))
      : left;
  return { left, right, sampleRate: TARGET_SR };
}

/** File/ArrayBuffer → 정확히 44100Hz 디코드 → separate. */
export async function separateFile(
  file: ArrayBuffer,
  modelBytes: ArrayBuffer,
  opts: {
    onProgress?: (chunk: number, total: number) => void;
    onStatus?: (s: BackendStatus) => void;
    audioContext?: AudioContext;
  } = {},
): Promise<SeparationResult> {
  const pcm = await decodeAudioFile(file);
  return separate(pcm, modelBytes, {
    onProgress: opts.onProgress,
    onStatus: opts.onStatus,
    audioContext: opts.audioContext,
  });
}
