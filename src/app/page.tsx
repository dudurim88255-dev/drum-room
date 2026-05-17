"use client";

import { useCallback, useState } from "react";
import UploadView from "@/components/UploadView";
import SeparatingView from "@/components/SeparatingView";
import PracticeView from "@/components/PracticeView";

// 단일 페이지 + 세 화면을 하나의 stage 값으로 전환.
// 2단계는 "움직이는 와이어프레임" — 보고 만질 수 있지만 소리는 없다.
type Stage = "upload" | "separating" | "practice";

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  // 고른 파일 — 2단계에선 제목 표시만, 실제 사용은 3·4단계
  const [file, setFile] = useState<File | null>(null);
  const [drumVolume, setDrumVolume] = useState(25);
  const [isPlaying, setIsPlaying] = useState(false);

  const handleFileSelected = useCallback((picked: File) => {
    setFile(picked);
    setStage("separating");
  }, []);

  // SeparatingView가 100% 도달 시 호출 (useEffect deps라 안정 참조 필요)
  const handleSeparationDone = useCallback(() => {
    setStage("practice");
  }, []);

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // 콘솔 카드는 세로 중앙보다 살짝 위 (DESIGN.md §5)
        justifyContent: "center",
        padding: "var(--space-12) var(--space-4)",
        gap: "var(--space-8)",
      }}
    >
      {/* 상단 라벨 — Caption, text-muted */}
      <span
        style={{
          fontSize: "13px",
          fontWeight: 500,
          letterSpacing: "0.08em",
          color: "var(--color-text-muted)",
        }}
      >
        DRUM-ROOM
      </span>

      {/* 콘솔 카드 — 세 화면의 내용물이 이 안에서 교체된다 */}
      <div
        style={{
          width: "100%",
          maxWidth: "560px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-md)",
          padding: "var(--space-8)",
        }}
      >
        {stage === "upload" && (
          <UploadView onFileSelected={handleFileSelected} />
        )}
        {stage === "separating" && (
          <SeparatingView onDone={handleSeparationDone} />
        )}
        {stage === "practice" && (
          <PracticeView
            fileName={file?.name ?? null}
            drumVolume={drumVolume}
            setDrumVolume={setDrumVolume}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
          />
        )}
      </div>
    </main>
  );
}
