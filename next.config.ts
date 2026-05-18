import type { NextConfig } from "next";

// 분리 추론 WASM 멀티스레드는 SharedArrayBuffer 가 필요하고, 브라우저는
// COOP/COEP 헤더로 crossOriginIsolated 일 때만 이를 허용한다. onnxruntime-web
// 은 crossOriginIsolated=false 면 자동으로 numThreads=1 로 폴백하므로(품질
// 무손상, 속도만 단일스레드), 이 헤더가 멀티스레드의 하드 전제다.
// ※ next dev 에서는 이 headers() 가 적용된다. 정적 export 배포에서는
//   headers() 가 무시되므로 같은 헤더를 vercel.json 에 별도 정의한다.
const COI_HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

const nextConfig: NextConfig = {
  // 홈 디렉터리의 무관한 package-lock.json 때문에 Turbopack 이 워크스페이스 root 를
  // 잘못 추론하는 것을 막는다. 이 프로젝트 폴더를 root 로 고정.
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [{ source: "/:path*", headers: COI_HEADERS }];
  },
};

export default nextConfig;
