"use client";

import type { CSSProperties } from "react";

// 1차의 메인 화면. 2단계에서는 소리 없이 모양·클릭 반응만.
// 실제 Web Audio 재생·게인 연결은 3단계.
const PRESETS = [
  { label: "드럼없이", value: 0 },
  { label: "가이드", value: 25 },
  { label: "원곡", value: 100 },
] as const;

export default function PracticeView({
  fileName,
  drumVolume,
  setDrumVolume,
  isPlaying,
  setIsPlaying,
}: {
  fileName: string | null;
  drumVolume: number;
  setDrumVolume: (v: number) => void;
  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;
}) {
  const title = fileName ?? "연습 곡";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // 컨트롤 사이 간격 최소 --space-6 (DESIGN.md §5)
        gap: "var(--space-8)",
      }}
    >
      {/* 곡 제목 — H2 스케일 */}
      <h2
        style={{
          fontSize: "22px",
          fontWeight: 600,
          lineHeight: 1.35,
          letterSpacing: "-0.01em",
          color: "var(--color-text)",
          margin: 0,
          textAlign: "center",
          wordBreak: "break-all", // 긴 파일명도 카드 안에서 끊기게
        }}
      >
        {title}
      </h2>

      {/* 재생 / 정지 — 원형 64px, 재생 중 글로우 */}
      <button
        type="button"
        className="action-btn"
        data-playing={isPlaying}
        aria-label={isPlaying ? "정지" : "재생"}
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <StopIcon /> : <PlayIcon />}
      </button>

      {/* 드럼 볼륨 슬라이더 — 1차의 핵심 컨트롤 */}
      <div style={{ width: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: "var(--space-3)",
          }}
        >
          {/* 라벨 — Caption */}
          <span
            style={{
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "0.02em",
              color: "var(--color-text-secondary)",
            }}
          >
            드럼 볼륨
          </span>
          {/* 현재 % — Numeric Display, tabular-nums */}
          <span
            style={{
              fontSize: "28px",
              fontWeight: 600,
              lineHeight: 1,
              color: "var(--color-accent)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {drumVolume}%
          </span>
        </div>
        <input
          type="range"
          className="drum-slider"
          min={0}
          max={100}
          value={drumVolume}
          aria-label="드럼 볼륨"
          onChange={(e) => setDrumVolume(Number(e.target.value))}
          // 채워진 부분 표현용 — pseudo-element track 그라디언트가 참조
          style={{ ["--fill"]: `${drumVolume}%` } as CSSProperties}
        />
      </div>

      {/* 프리셋 3버튼 — 누르면 슬라이더 점프, 일치 시 선택됨 */}
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="preset-btn"
            aria-pressed={drumVolume === p.value}
            onClick={() => setDrumVolume(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}
