"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { getAudioEngine } from "@/lib/audio-engine";

// 1차의 메인 화면. 4-C: 분리 엔진이 만든 두 트랙이 이미 재생 엔진에
// 주입돼 있다(SeparatingView 가 engine.loadBuffers 후 전환). 여기선 재생/
// 드럼 볼륨/프리셋만 — 3단계에서 검증된 로직 그대로, 입력 소스만 분리 결과.
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
  const engineRef = useRef(getAudioEngine());

  useEffect(() => {
    const engine = engineRef.current;
    engine.setDrumVolume(drumVolume / 100);
    // 트랙이 끝까지 가면 자동 정지 → 버튼도 정지 상태로
    engine.setOnEnded(() => setIsPlaying(false));
    return () => {
      engine.setOnEnded(null);
      engine.stop();
      setIsPlaying(false);
    };
    // 마운트 1회 (drumVolume 초기값). 이후 변경은 핸들러가 직접 반영.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function togglePlay() {
    const engine = engineRef.current;
    if (engine.isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      await engine.play();
      setIsPlaying(engine.isPlaying);
    }
  }

  // 슬라이더/프리셋: React 상태(표시·선택)와 audio 게인을 함께 갱신.
  // 게인은 엔진에 직접(틱 잡음 방지 스무딩은 엔진 내부에서 처리).
  function applyVolume(v: number) {
    setDrumVolume(v);
    engineRef.current.setDrumVolume(v / 100);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-8)",
      }}
    >
      {/* 곡 제목 — H2 스케일. 사용자가 넣은 파일명 */}
      <div style={{ textAlign: "center" }}>
        <h2
          style={{
            fontSize: "22px",
            fontWeight: 600,
            lineHeight: 1.35,
            letterSpacing: "-0.01em",
            color: "var(--color-text)",
            margin: 0,
            wordBreak: "break-all",
          }}
        >
          {fileName ?? "연습 곡"}
        </h2>
        <p
          style={{
            fontSize: "13px",
            fontWeight: 500,
            letterSpacing: "0.02em",
            color: "var(--color-text-muted)",
            margin: "var(--space-2) 0 0",
          }}
        >
          드럼 분리 완료 — 드럼 볼륨을 조절하며 그 위에 치세요
        </p>
      </div>

      {/* 재생 / 정지 — 원형 64px, 재생 중 글로우 */}
      <button
        type="button"
        className="action-btn"
        data-playing={isPlaying}
        aria-label={isPlaying ? "정지" : "재생"}
        onClick={togglePlay}
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
          onChange={(e) => applyVolume(Number(e.target.value))}
          style={{ ["--fill"]: `${drumVolume}%` } as CSSProperties}
        />
      </div>

      {/* 프리셋 3버튼 — 슬라이더값과 게인을 함께 바꾼다 */}
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="preset-btn"
            aria-pressed={drumVolume === p.value}
            onClick={() => applyVolume(p.value)}
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
