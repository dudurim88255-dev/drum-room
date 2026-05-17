"use client";

import { useEffect, useRef, useState } from "react";

const TOTAL_SEGMENTS = 13;
const DURATION_MS = 4000;
const TICK_MS = 40; // 40ms마다 +1% → 약 4초에 100%

// 분리 중 화면. 2단계에서는 실제 분리 대신 가짜로 0→100% 진행시키고,
// 다 차면 연습 화면으로 넘긴다. (실제 모델 다운로드·분리는 4단계)
export default function SeparatingView({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  // StrictMode 이중 실행·중복 onDone 호출 방지
  const doneRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 진행률만 올린다. setState 업데이터는 순수해야 하므로 여기서 onDone 호출 금지.
  useEffect(() => {
    const step = 100 / (DURATION_MS / TICK_MS);
    intervalRef.current = setInterval(() => {
      setProgress((prev) => (prev + step >= 100 ? 100 : prev + step));
    }, TICK_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // 완료 감지·전환은 커밋 단계(effect)에서 — 렌더 중 부모 setState 금지 위반 방지
  useEffect(() => {
    if (progress >= 100 && !doneRef.current) {
      doneRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      onDone();
    }
  }, [progress, onDone]);

  const pct = Math.round(progress);
  const segment = Math.ceil((progress / 100) * TOTAL_SEGMENTS);

  return (
    <div style={{ textAlign: "center" }}>
      {/* 단계 안내 — H2 스케일 + 퍼센트 */}
      <h2
        style={{
          fontSize: "22px",
          fontWeight: 600,
          lineHeight: 1.35,
          letterSpacing: "-0.01em",
          color: "var(--color-text)",
          margin: 0,
        }}
      >
        드럼 분리 중...{" "}
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
      </h2>

      {/* 진행률 바 — DESIGN.md §4 */}
      <div
        style={{
          height: "6px",
          background: "var(--color-surface-inset)",
          borderRadius: "var(--radius-full)",
          overflow: "hidden",
          margin: "var(--space-6) 0 var(--space-3)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${progress}%`,
            background: "var(--color-accent)",
            borderRadius: "var(--radius-full)",
            transition: "width 300ms ease",
          }}
        />
      </div>

      {/* 보조 텍스트 — Body Small, text-secondary */}
      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-secondary)",
          margin: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        세그먼트 {segment}/{TOTAL_SEGMENTS}
      </p>

      {/* 최초 1회 모델 다운로드 안내 — 실제 다운로드는 4단계, 지금은 문구만 */}
      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
          margin: "var(--space-6) 0 0",
        }}
      >
        최초 1회: 모델 다운로드 81MB
      </p>
    </div>
  );
}
