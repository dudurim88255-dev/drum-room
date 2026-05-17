import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "drum-room",
  description: "드럼 연습 스튜디오 — 원곡 위에서 드럼 볼륨을 조절하며 친다",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        {/* Pretendard 웹폰트 — CDN 방식 (별도 패키지 설치 없음) */}
        <link
          rel="preconnect"
          href="https://cdn.jsdelivr.net"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css"
        />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
