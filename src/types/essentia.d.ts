// essentia.js 0.1.3 — 패키지가 별도 types entry 없음. 사용 API 작아서 최소 선언.
declare module "essentia.js/dist/essentia.js-core.es.js" {
  // 큰 표면이라 any (PercivalBpmEstimator·arrayToVector·delete 만 사용)
  const Essentia: new (wasm: unknown) => {
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
    delete?: () => void;
  };
  export default Essentia;
}
declare module "essentia.js/dist/essentia-wasm.es.js" {
  // 인라인 WASM 모듈(공장 함수 또는 사전초기화 객체 — 둘 다 호환)
  export const EssentiaWASM: unknown;
}
declare module "essentia.js/dist/essentia-wasm.web.js" {
  // 브라우저 전용 UMD 빌드 — factory(opts?): Promise<Module>.
  // 외부 .wasm 파일 fetch (locateFile 로 경로 지정). Node 의존 없음.
  const factory: (options?: {
    locateFile?: (file: string) => string;
  }) => Promise<unknown>;
  export default factory;
}
