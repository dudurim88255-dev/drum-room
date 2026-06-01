/// <reference lib="webworker" />
// 분리 추론 Worker. 메인 스레드를 막지 않도록 STFT+ONNX 추론+overlap-add 를
// 여기서 수행하고, 청크 진행률을 메인으로 보고한다.
// 2차-8: ONNX 추론을 SeparationBackend(WASM/WebGPU)로 추상화. 백엔드 선택만
// 추가됐고 STFT(buildSpec)·ISTFT(spectralWaveform)·가중 OLA·정규화·매핑은
// 무변경 → WASM 경로 출력은 이전 커밋과 비트 동일.
import * as ort from "onnxruntime-web";
import { buildSpec, SEG } from "./stft";
import { spectralWaveform } from "./istft";
import {
  createBackend,
  hasWorkerWebGpu,
  type BackendName,
  type ChunkOutput,
  type SeparationBackend,
} from "./separation-backend";

// 멀티스레드 WASM: crossOriginIsolated(COOP/COEP)면 코어 수만큼 추론을 병렬
// 처리해 속도↑. 같은 모델·같은 연산, 일꾼 수만 늘림 → 분리 품질 불변.
// onnxruntime-web 은 self.crossOriginIsolated=false 면 자동으로 numThreads=1
// 로 폴백한다(backend-wasm.ts) → 헤더가 없거나 막혀도 안전(정답 동일, 단
// 단일스레드라 느릴 뿐). 전부 쓰지 않고 1코어는 남긴다(UI/메인 여유).
// WebGPU EP 도 같은 jsep wasm 모듈을 쓰므로 이 env 설정(특히 wasmPaths)이
// webgpu 세션 생성 전에도 적용돼야 한다 — 모듈 최상위에서 1회 설정.
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
const MSE_GATE = 1e-5; // WebGPU 락 음질 동일성 한도(부동소수점 정상 오차)
// WebGPU 락 보수적 마진: readback·JS orchestration 변동성을 흡수하려고 WebGPU 가
// 명확히(steady 기준 30% 이상) 빠를 때만 락한다. 근소한 우위는 WASM 유지.
const WEBGPU_MARGIN = 1.3;

type InMsg = {
  modelBytes: ArrayBuffer;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  // 영속 결정(메인 thread localStorage)이 있으면 벤치마크 스킵. null=벤치마크.
  forcedBackend: BackendName | null;
  // 메인 thread navigator.gpu 가용 힌트(없으면 벤치마크 자체 불필요).
  webgpuAvailable: boolean;
  // operator fallback 프로파일링(dev 전용). 제품 경로에선 미설정.
  profile?: boolean;
};

type Selection = {
  backend: SeparationBackend;
  name: BackendName;
  source: "forced" | "benchmark" | "default" | "fallback";
  metrics?: { tWasm: number; tGpu: number; mse: number };
};

type Accumulator = {
  dL: Float64Array;
  dR: Float64Array;
  bL: Float64Array;
  bR: Float64Array;
  wsum: Float64Array;
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

const newAccumulator = (n: number): Accumulator => ({
  dL: new Float64Array(n),
  dR: new Float64Array(n),
  bL: new Float64Array(n),
  bR: new Float64Array(n),
  wsum: new Float64Array(n),
});

// 한 청크의 실제 전체 처리: ISTFT(스펙트럼분기 add_76) + 가중 OLA 누적.
// runLoop(실 분리)와 벤치마크(공정 측정)가 이 함수를 공유해 측정 작업량을
// 분리 작업량과 정확히 일치시킨다. OLA/정규화 산식은 이전 커밋과 동일(비트 동일).
// HTDemucs 하이브리드: 최종 소스 = 시간분기 add_77(xt) + ISTFT(add_76). host 가
// add_76 을 _ispec 해 add_77 에 가산해야 한다(절반만 쓰면 각 소스 ~30% 손실).
function accumulateChunk(
  out: ChunkOutput,
  sOffset: number,
  len: number,
  acc: Accumulator,
): void {
  const y = out.add77;
  // xspec layout 은 add_77 과 동일 ((src*2+ch)*SEG + i) → 그대로 가산
  const xspec = spectralWaveform(out.add76);
  const SRC = SEG; // 채널당 샘플 수
  const { dL, dR, bL, bR, wsum } = acc;
  for (let i = 0; i < len; i++) {
    const t = sOffset + i;
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
}

// add_77 + ISTFT(add_76) → 소스별 결합 파형 (MSE 비교용). layout 은 OLA 와 동일.
function combined(o: ChunkOutput): Float32Array {
  const xspec = spectralWaveform(o.add76);
  const y = o.add77;
  const comb = new Float32Array(4 * 2 * SEG);
  for (let i = 0; i < comb.length; i++) comb[i] = y[i] + xspec[i];
  return comb;
}

// 소스별(0..3) 최악 MSE — 음질 동일성 게이트.
function maxSourceMse(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  const cnt = 2 * SEG;
  for (let src = 0; src < 4; src++) {
    let sum = 0;
    const base = src * cnt;
    for (let i = 0; i < cnt; i++) {
      const d = a[base + i] - b[base + i];
      sum += d * d;
    }
    const mse = sum / cnt;
    if (mse > worst) worst = mse;
  }
  return worst;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const post = (m: unknown, transfer?: Transferable[]) =>
    (self as DedicatedWorkerGlobalScope).postMessage(m, transfer ?? []);
  try {
    const { modelBytes, sampleRate, forcedBackend, webgpuAvailable, profile } =
      e.data;
    let L = e.data.left;
    let R = e.data.right;
    if (sampleRate !== TARGET_SR) {
      L = resample(L, sampleRate, TARGET_SR);
      R = resample(R, sampleRate, TARGET_SR);
    }
    const N = Math.max(L.length, R.length);

    const starts: number[] = [];
    for (let s = 0; s < N; s += STRIDE) starts.push(s);
    const total = starts.length;

    // 한 청크 추출 (기존 인라인 추출과 동일 값 — 꼬리는 무음 패딩).
    const extractChunk = (s: number) => {
      const cl = new Float32Array(SEG);
      const cr = new Float32Array(SEG);
      const len = Math.min(SEG, N - s);
      for (let i = 0; i < len; i++) {
        cl[i] = L[s + i] ?? 0;
        cr[i] = R[s + i] ?? 0;
      }
      const mix = new Float32Array(2 * SEG);
      mix.set(cl, 0);
      mix.set(cr, SEG);
      const spec = buildSpec(cl, cr); // 검증된 STFT
      return { mix, spec, len };
    };

    // ── 백엔드 실측 head-to-head (벤치마크) ─────────────────────────────
    // 공정 측정(2차-8 회귀 수정): WASM·WebGPU **둘 다** 워밍업 1청크(chunk0,
    // untimed)를 먼저 돌려 ORT 런타임을 데운 뒤, steady 1청크(chunk1)를 잰다.
    // (이전 버그: WASM 은 chunk0=워밍업 포함으로, WebGPU 는 chunk1=steady 로
    //  재 비대칭 측정 → WASM 이 억울하게 느려 WebGPU 오락.) 측정 구간도
    // inferChunk 뿐 아니라 그 청크의 **실제 전체 처리**(infer + ISTFT +
    // 가중 OLA)로 잡아 readback·후처리까지 포함한 per-chunk 시간으로 비교한다.
    // WebGPU 락 = (tGpu * MARGIN < tWasm) AND (chunk0 스템별 MSE ≤ 1e-5).
    // 둘 중 하나라도 실패 → WASM 락(음질·안정성·근소차 보호).
    const benchmark = async (): Promise<Selection> => {
      const wasm = await createBackend("wasm", modelBytes);
      const c0 = extractChunk(starts[0]);
      const cS = total >= 2 ? extractChunk(starts[1]) : c0;

      // 한 백엔드 공정 측정: warmup chunk0(MSE 비교용 comb 도 확보) → steady chunk1
      // 전체 처리 시간(infer + ISTFT + OLA). scratch 누적(SEG 길이, 결과 폐기).
      const measure = async (backend: SeparationBackend) => {
        const warm = await backend.inferChunk(c0.mix, c0.spec); // 워밍업
        const comb = combined(warm); // chunk0 결합 파형(MSE 비교)
        const scratch = newAccumulator(SEG);
        const t0 = performance.now();
        const outS = await backend.inferChunk(cS.mix, cS.spec);
        accumulateChunk(outS, 0, cS.len, scratch); // sOffset 0 → [0,len) 기록
        const tSteady = performance.now() - t0;
        return { comb, tSteady };
      };

      const wasmM = await measure(wasm);

      let gpu: SeparationBackend | null = null;
      try {
        gpu = await createBackend("webgpu", modelBytes, { profile });
      } catch {
        gpu = null; // webgpu 세션 생성 실패 → WASM
      }
      if (!gpu) {
        return { backend: wasm, name: "wasm", source: "benchmark" };
      }
      try {
        const gpuM = await measure(gpu);
        const tWasm = wasmM.tSteady;
        const tGpu = gpuM.tSteady;
        const mse = maxSourceMse(wasmM.comb, gpuM.comb);
        const lockGpu = tGpu * WEBGPU_MARGIN < tWasm && mse <= MSE_GATE;
        if (lockGpu) {
          await wasm.dispose();
          return {
            backend: gpu,
            name: "webgpu",
            source: "benchmark",
            metrics: { tWasm, tGpu, mse },
          };
        }
        await gpu.dispose();
        return {
          backend: wasm,
          name: "wasm",
          source: "benchmark",
          metrics: { tWasm, tGpu, mse },
        };
      } catch {
        // WebGPU 추론 중 throw → 안전하게 WASM
        try {
          await gpu.dispose();
        } catch {
          /* noop */
        }
        return { backend: wasm, name: "wasm", source: "benchmark" };
      }
    };

    // ── 백엔드 결정 ─────────────────────────────────────────────────────
    const willBenchmark =
      !forcedBackend && webgpuAvailable && hasWorkerWebGpu();
    const willUseGpu = forcedBackend === "webgpu" || willBenchmark;
    // WebGPU 는 컴파일/벤치마크로 첫 진행률까지 시간이 걸림 → "가속 준비 중…" 신호.
    if (willUseGpu) post({ type: "preparing" });

    let sel: Selection;
    if (forcedBackend === "webgpu") {
      try {
        const b = await createBackend("webgpu", modelBytes, { profile });
        sel = { backend: b, name: "webgpu", source: "forced" };
      } catch {
        const b = await createBackend("wasm", modelBytes);
        sel = { backend: b, name: "wasm", source: "fallback" };
      }
    } else if (forcedBackend === "wasm") {
      const b = await createBackend("wasm", modelBytes);
      sel = { backend: b, name: "wasm", source: "forced" };
    } else if (willBenchmark) {
      sel = await benchmark();
    } else {
      const b = await createBackend("wasm", modelBytes);
      sel = { backend: b, name: "wasm", source: "default" };
    }

    post({
      type: "backend",
      name: sel.name,
      source: sel.source,
      metrics: sel.metrics,
    });

    // ── 분리 루프 (accumulateChunk 공유 — OLA/정규화 비트 동일) ───────────
    const runLoop = async (backend: SeparationBackend): Promise<Accumulator> => {
      const acc = newAccumulator(N);
      for (let ci = 0; ci < total; ci++) {
        const s = starts[ci];
        const { mix, spec, len } = extractChunk(s);
        const out = await backend.inferChunk(mix, spec);
        accumulateChunk(out, s, len, acc);
        post({ type: "progress", chunk: ci + 1, total });
      }
      return acc;
    };

    // WebGPU 도중 GPU 에러 → WASM 으로 곡 단위 재시작(누적 버퍼는 runLoop 안에서
    // 새로 시작하므로 깨끗이 다시 분리). 안정성 우선.
    let active = sel.backend;
    let acc: Accumulator;
    try {
      acc = await runLoop(active);
    } catch (loopErr) {
      if (sel.name === "webgpu") {
        try {
          await active.dispose();
        } catch {
          /* noop */
        }
        active = await createBackend("wasm", modelBytes);
        post({ type: "backend", name: "wasm", source: "fallback" });
        acc = await runLoop(active); // 여기서 또 throw 면 바깥 catch → error
      } else {
        throw loopErr;
      }
    }
    try {
      await active.dispose();
    } catch {
      /* noop */
    }

    // 가중치 정규화
    const { dL, dR, bL, bR, wsum } = acc;
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

    post(
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
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
