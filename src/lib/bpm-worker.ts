/// <reference lib="webworker" />
// BPM 분석 Web Worker — Essentia.js PercivalBpmEstimator.
// Turbopack 의 정적 분기 제거가 Emscripten 의 worker 환경 감지를 잘라
// `document.currentScript` 무가드 접근으로 망가뜨림 → ESM import 우회.
// 런타임 fetch + Function 평가로 Essentia(UMD) 를 self 에 부착해 사용.
// WASM/JS 모두 자기호스팅(/essentia/), COEP·CORS 무관(같은 출처).

type InMsg = {
  drumsL: Float32Array;
  drumsR: Float32Array;
  sampleRate: number;
};

type EssentiaInstance = {
  arrayToVector(arr: Float32Array): unknown;
  PercivalBpmEstimator(
    signal: unknown,
    frameSize?: number,
    frameSizeOSS?: number,
    hopSize?: number,
    hopSizeOSS?: number,
    maxBPM?: number,
    minBPM?: number,
    sampleRate?: number,
  ): { bpm: number };
};

type SelfWithEssentia = DedicatedWorkerGlobalScope & {
  EssentiaWASM?: (opts?: {
    locateFile?: (f: string) => string;
  }) => Promise<unknown>;
  Essentia?: new (wasm: unknown) => EssentiaInstance;
};

let essentia: EssentiaInstance | null = null;

// essentia-wasm.web.js 는 `-s ENVIRONMENT=web` 으로 빌드돼 ENVIRONMENT_IS_WEB
// 만 true(WORKER 는 하드코드 false). 초기화 중 `else if(document.currentScript)`
// 가 무조건 평가되는데 worker 엔 document 없음 → ReferenceError. 해법: 워커에
// document 가장 작은 shim(currentScript=null)을 둬서 조건 false 로 만들고
// 분기 안 들어가게 한다. 실제 wasm 경로는 우리 Module 옵션 locateFile 이 결정.
type WithDocument = DedicatedWorkerGlobalScope & { document?: unknown };
const _g = self as WithDocument;
if (typeof _g.document === "undefined") {
  _g.document = { currentScript: null };
}

// 번들러(Turbopack) 정적 분석 우회 + UMD 의 top-level var 를 self 에 노출:
// 자기호스팅 UMD 를 fetch 해 **간접 eval** 로 글로벌 스코프 실행
// → var EssentiaWASM/Essentia 가 self.X 로 노출(classic-script 의미).
async function loadUmdIntoSelf(url: string): Promise<void> {
  const code = await (await fetch(url)).text();
  (0, eval)(code);
}

async function ensureEssentia(): Promise<EssentiaInstance> {
  if (essentia) return essentia;
  const s = self as SelfWithEssentia;
  if (!s.EssentiaWASM) await loadUmdIntoSelf("/essentia/essentia-wasm.web.js");
  if (!s.Essentia) await loadUmdIntoSelf("/essentia/essentia.js-core.umd.js");
  if (!s.EssentiaWASM || !s.Essentia) {
    throw new Error("Essentia load failed (UMD not exposed to self)");
  }
  const wasm = await s.EssentiaWASM({
    locateFile: (file) => `/essentia/${file}`,
  });
  essentia = new s.Essentia(wasm);
  return essentia;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    const { drumsL, drumsR, sampleRate } = e.data;
    const ess = await ensureEssentia();
    // 모노 다운믹스(분리된 drums 신호에서 BPM 만 필요 — 채널 정보 무관)
    const n = Math.min(drumsL.length, drumsR.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (drumsL[i] + drumsR[i]) * 0.5;
    const vec = ess.arrayToVector(mono);
    const res = ess.PercivalBpmEstimator(
      vec,
      1024,
      2048,
      128,
      128,
      210,
      50,
      sampleRate,
    );
    const bpm = Math.round(res?.bpm ?? 0);
    if (!bpm || bpm < 40 || bpm > 240) {
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: "error",
        message: `bpm out of range: ${bpm}`,
      });
      return;
    }
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "done", bpm });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
