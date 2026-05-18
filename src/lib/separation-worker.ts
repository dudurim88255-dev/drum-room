/// <reference lib="webworker" />
// 분리 추론 Worker. 메인 스레드를 막지 않도록 STFT+ONNX 추론+overlap-add 를
// 여기서 수행하고, 청크 진행률을 메인으로 보고한다.
import * as ort from "onnxruntime-web";
import { buildSpec, SEG } from "./stft";
import { spectralWaveform } from "./istft";

// 멀티스레드 WASM: crossOriginIsolated(COOP/COEP)면 코어 수만큼 추론을 병렬
// 처리해 속도↑. 같은 모델·같은 연산, 일꾼 수만 늘림 → 분리 품질 불변.
// onnxruntime-web 은 self.crossOriginIsolated=false 면 자동으로 numThreads=1
// 로 폴백한다(backend-wasm.ts) → 헤더가 없거나 막혀도 안전(정답 동일, 단
// 단일스레드라 느릴 뿐). 전부 쓰지 않고 1코어는 남긴다(UI/메인 여유).
const HC =
  typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
ort.env.wasm.numThreads = Math.max(1, Math.min(HC - 1, 8));
ort.env.wasm.simd = true;
// COEP require-corp 환경에선 CDN(cross-origin) wasm 로딩이 차단될 수 있다.
// onnxruntime-web wasm 을 같은 출처(public/ort/)로 자기호스팅 → COEP 무관.
ort.env.wasm.wasmPaths = "/ort/";

const TARGET_SR = 44100;
const OVERLAP = 0.25; // Demucs 기본
const STRIDE = Math.floor(SEG * (1 - OVERLAP)); // 330750

type InMsg = {
  modelBytes: ArrayBuffer;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
};

// 선형 리샘플 (1차 허용 — 검증 경로는 네이티브 44100 이라 미사용).
function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const y = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, x.length - 1);
    const t = p - i0;
    y[i] = x[i0] * (1 - t) + x[i1] * t;
  }
  return y;
}

// 0 이 되지 않는 매끄러운 창 (sin^2) — 가중 overlap-add 용.
const WIN = new Float64Array(SEG);
for (let i = 0; i < SEG; i++) {
  const s = Math.sin((Math.PI * (i + 0.5)) / SEG);
  WIN[i] = s * s;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    const { modelBytes, sampleRate } = e.data;
    let L = e.data.left;
    let R = e.data.right;
    if (sampleRate !== TARGET_SR) {
      L = resample(L, sampleRate, TARGET_SR);
      R = resample(R, sampleRate, TARGET_SR);
    }
    const N = Math.max(L.length, R.length);

    const session = await ort.InferenceSession.create(
      new Uint8Array(modelBytes),
      { executionProviders: ["wasm"] },
    );
    const [inMix, inSpec] = session.inputNames;

    // 출력 누적 (drums = src0, backing = src1+2+3) + 가중치 합
    const dL = new Float64Array(N);
    const dR = new Float64Array(N);
    const bL = new Float64Array(N);
    const bR = new Float64Array(N);
    const wsum = new Float64Array(N);

    const starts: number[] = [];
    for (let s = 0; s < N; s += STRIDE) starts.push(s);
    const total = starts.length;

    const mix = new Float32Array(2 * SEG);
    for (let ci = 0; ci < total; ci++) {
      const s = starts[ci];
      // 청크 추출 (꼬리는 무음 패딩)
      const cl = new Float32Array(SEG);
      const cr = new Float32Array(SEG);
      const len = Math.min(SEG, N - s);
      for (let i = 0; i < len; i++) {
        cl[i] = L[s + i] ?? 0;
        cr[i] = R[s + i] ?? 0;
      }
      mix.set(cl, 0);
      mix.set(cr, SEG);

      const spec = buildSpec(cl, cr); // 검증된 STFT
      const feeds: Record<string, ort.Tensor> = {
        [inMix]: new ort.Tensor("float32", mix, [1, 2, SEG]),
        [inSpec]: new ort.Tensor("float32", spec, [1, 2, 2048, 431, 2]),
      };
      const out = await session.run(feeds);
      // HTDemucs 하이브리드: 최종 소스 = 시간분기 add_77(xt) +
      // ISTFT(스펙트럼분기 add_76). ONNX 는 둘을 raw 로만 내보내므로
      // host 가 add_76 을 _ispec 해 add_77 에 가산해야 한다(절반만 쓰면
      // 각 소스 ~30% 손실 → 분리 뭉개짐). 둘 다 [1,4,2,SEG] / cac.
      const w =
        (out["add_77"] as ort.Tensor | undefined) ??
        (out[session.outputNames[1]] as ort.Tensor);
      const y = w.data as Float32Array;
      const sw =
        (out["add_76"] as ort.Tensor | undefined) ??
        (out[session.outputNames[0]] as ort.Tensor);
      // xspec layout 은 add_77 과 동일 ((src*2+ch)*SEG + i) → 그대로 가산
      const xspec = spectralWaveform(sw.data as Float32Array);
      const SRC = SEG; // 채널당 샘플 수
      // 인덱스: ((src*2 + ch)*SEG + i)
      for (let i = 0; i < len; i++) {
        const t = s + i;
        const ww = WIN[i];
        const d0L = y[(0 * 2 + 0) * SRC + i] + xspec[(0 * 2 + 0) * SRC + i];
        const d0R = y[(0 * 2 + 1) * SRC + i] + xspec[(0 * 2 + 1) * SRC + i];
        let bl = 0;
        let br = 0;
        for (let src = 1; src < 4; src++) {
          bl += y[(src * 2 + 0) * SRC + i] + xspec[(src * 2 + 0) * SRC + i];
          br += y[(src * 2 + 1) * SRC + i] + xspec[(src * 2 + 1) * SRC + i];
        }
        dL[t] += d0L * ww;
        dR[t] += d0R * ww;
        bL[t] += bl * ww;
        bR[t] += br * ww;
        wsum[t] += ww;
      }
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: "progress",
        chunk: ci + 1,
        total,
      });
    }
    await session.release();

    // 가중치 정규화
    const drumsL = new Float32Array(N);
    const drumsR = new Float32Array(N);
    const backingL = new Float32Array(N);
    const backingR = new Float32Array(N);
    for (let t = 0; t < N; t++) {
      const wv = wsum[t] || 1;
      drumsL[t] = dL[t] / wv;
      drumsR[t] = dR[t] / wv;
      backingL[t] = bL[t] / wv;
      backingR[t] = bR[t] / wv;
    }

    (self as DedicatedWorkerGlobalScope).postMessage(
      {
        type: "done",
        drumsL,
        drumsR,
        backingL,
        backingR,
        length: N,
        sampleRate: TARGET_SR,
      },
      [drumsL.buffer, drumsR.buffer, backingL.buffer, backingR.buffer],
    );
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
