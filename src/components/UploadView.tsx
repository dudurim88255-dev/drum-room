"use client";

import { useRef, useState } from "react";

// 곡 넣기 화면. 2단계에서는 파일 내용을 처리하지 않고, 어떤 오디오 파일이든
// 받으면 다음 단계로 넘긴다. (파일 객체는 page 상태에 저장 — 3·4단계에서 사용)
export default function UploadView({
  onFileSelected,
  error,
}: {
  onFileSelected: (file: File) => void;
  error?: string | null;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 드롭존 클릭 → 숨겨진 file input 열기
  function openPicker() {
    inputRef.current?.click();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileSelected(file);
  }

  return (
    <div>
      {error && (
        <p
          role="alert"
          style={{
            fontSize: "14px",
            lineHeight: 1.6,
            color: "var(--color-error)",
            margin: "0 0 var(--space-4)",
            textAlign: "center",
          }}
        >
          {error}
        </p>
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") openPicker();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      style={{
        // DESIGN.md §4 드롭존 — 기본 / 드래그오버 상태
        background: isDragOver
          ? "var(--color-surface-elevated)"
          : "var(--color-surface)",
        border: isDragOver
          ? "2px dashed var(--color-accent)"
          : "2px dashed var(--color-border-strong)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-16)",
        textAlign: "center",
        cursor: "pointer",
        transform: isDragOver ? "scale(1.01)" : "scale(1)",
        transition: "transform 150ms ease, background 150ms ease",
        outline: "none",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.m4a"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelected(file);
        }}
      />

      {/* 안내 문구 — Body Large, text-secondary */}
      <p
        style={{
          fontSize: "18px",
          lineHeight: 1.7,
          color: "var(--color-text-secondary)",
          margin: 0,
        }}
      >
        곡 파일을 여기에 드래그
      </p>

      {/* 보조 문구 — Body Small, text-muted */}
      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
          margin: "var(--space-3) 0 0",
        }}
      >
        mp3 / wav / flac / m4a
      </p>
      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
          margin: "var(--space-1) 0 0",
        }}
      >
        파일은 브라우저 밖으로 안 나갑니다
      </p>
      </div>
    </div>
  );
}
