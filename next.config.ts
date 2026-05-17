import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 홈 디렉터리의 무관한 package-lock.json 때문에 Turbopack 이 워크스페이스 root 를
  // 잘못 추론하는 것을 막는다. 이 프로젝트 폴더를 root 로 고정.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
