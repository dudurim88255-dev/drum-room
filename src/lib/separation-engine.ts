// 분리 엔진 (메인 스레드 인터페이스).
// 무거운 STFT+ONNX 추론은 Web Worker(separation-worker)에서 수행.
// 출력: { drumsBuffer, backingBuffer } 두 AudioBuffer — 3단계 재생 엔진
// audio-engine 의 입력과 그대로 맞물린다(에셋 비의존 설계).

export type SeparationResult = {
  drumsBuffer: AudioBuffer;
  backingBuffer: AudioBuffer;
};

export type Pcm = {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
};

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
type ErrorMsg = { type: "error"; message: string };
type OutMsg = DoneMsg | ProgressMsg | ErrorMsg;

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
export function separate(
  pcm: Pcm,
  modelBytes: ArrayBuffer,
  opts: {
    onProgress?: (chunk: number, total: number) => void;
    audioContext?: BaseAudioContext;
  } = {},
): Promise<SeparationResult> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("separate() is browser-only"));
  }
  return new Promise<SeparationResult>((resolve, reject) => {
    const worker = new Worker(
      new URL("./separation-worker.ts", import.meta.url),
      { type: "module" },
    );
    const ctx = opts.audioContext ?? new AudioContext();

    worker.onmessage = (e: MessageEvent<OutMsg>) => {
      const m = e.data;
      if (m.type === "progress") {
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
    audioContext?: AudioContext;
  } = {},
): Promise<SeparationResult> {
  const pcm = await decodeAudioFile(file);
  return separate(pcm, modelBytes, {
    onProgress: opts.onProgress,
    audioContext: opts.audioContext,
  });
}
