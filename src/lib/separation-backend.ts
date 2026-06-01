// 분리 백엔드 Facade (2차-8). 분리 엔진·worker·STFT·ISTFT·가중 OLA 로직은
// 무변경 — "어떤 실행 EP(WASM/WebGPU)로 ONNX 추론을 돌릴지"만 이 계층이
// 캡슐화한다. 같은 모델·같은 연산, 실행 백엔드만 다름 → 출력은 수치적으로
// 동일해야 한다(WebGPU 락 직전 런타임 MSE 게이트로 보장 — separation-worker).
//
// 음질 절대 무양보: fp32 유지, 양자화 없음. preferredOutputLocation 은
// 기본(cpu) — host 가 add_77/add_76 을 읽어 ISTFT/OLA 해야 하므로 GPU 버퍼로
// 두지 않는다.
import * as ort from "onnxruntime-web";
import { SEG, FREQS, FRAMES } from "./stft";

export type BackendName = "wasm" | "webgpu";

export type ChunkOutput = {
  add77: Float32Array; // 시간분기 [1,4,2,SEG]
  add76: Float32Array; // 스펙트럼분기 [1,4,4,FREQS,FRAMES] (host ISTFT 필요)
};

export interface SeparationBackend {
  readonly name: BackendName;
  /** 한 청크(스테레오 mix + 사전계산 spec) 추론 → raw 모델 출력 두 개. */
  inferChunk(mix: Float32Array, spec: Float32Array): Promise<ChunkOutput>;
  dispose(): Promise<void>;
}

class OrtBackend implements SeparationBackend {
  readonly name: BackendName;
  private session: ort.InferenceSession;
  private readonly inMix: string;
  private readonly inSpec: string;
  private readonly outNames: readonly string[];

  constructor(name: BackendName, session: ort.InferenceSession) {
    this.name = name;
    this.session = session;
    [this.inMix, this.inSpec] = session.inputNames;
    this.outNames = session.outputNames;
  }

  async inferChunk(mix: Float32Array, spec: Float32Array): Promise<ChunkOutput> {
    const feeds: Record<string, ort.Tensor> = {
      [this.inMix]: new ort.Tensor("float32", mix, [1, 2, SEG]),
      [this.inSpec]: new ort.Tensor("float32", spec, [1, 2, FREQS, FRAMES, 2]),
    };
    const out = await this.session.run(feeds);
    // 시간분기 add_77, 스펙트럼분기 add_76. 이름 우선, 없으면 인덱스 폴백
    // (출력 순서: [0]=add_76, [1]=add_77 — 4-D 매핑과 동일).
    const w =
      (out["add_77"] as ort.Tensor | undefined) ??
      (out[this.outNames[1]] as ort.Tensor);
    const sw =
      (out["add_76"] as ort.Tensor | undefined) ??
      (out[this.outNames[0]] as ort.Tensor);
    // ort-web 의 CPU 출력 텐서 data 는 JS 소유 Float32Array(복사본)이라
    // 이후 다른 run/세션이 있어도 안전하게 보유 가능.
    return {
      add77: w.data as Float32Array,
      add76: sw.data as Float32Array,
    };
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}

/**
 * 백엔드 생성. webgpu 가 가용하지 않으면 ort 가 throw → 호출부(worker)가 잡아
 * WASM 으로 폴백한다. 자산/import 변경 없음 — 현재 jsep 빌드(/ort/...jsep.wasm)가
 * WebGPU EP 를 포함하므로 executionProviders 만 분기한다.
 */
export async function createBackend(
  name: BackendName,
  modelBytes: ArrayBuffer,
  opts: { profile?: boolean } = {},
): Promise<SeparationBackend> {
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: [name],
  };
  // operator fallback 프로파일링(2차-8 도입 전 점검, dev 전용). 어떤 op 가 어느
  // backend 로 갔는지 endProfiling 으로 본다. 제품 경로에선 항상 false.
  if (name === "webgpu" && opts.profile) {
    options.enableProfiling = true;
  }
  const session = await ort.InferenceSession.create(
    new Uint8Array(modelBytes),
    options,
  );
  return new OrtBackend(name, session);
}

/** worker 스코프에 WebGPU 가 실제로 있는지 (없으면 webgpu 세션 생성이 throw). */
export function hasWorkerWebGpu(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!(navigator as unknown as { gpu?: unknown }).gpu
  );
}
