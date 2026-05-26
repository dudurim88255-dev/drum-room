"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listSongs, deleteSong, type SongMeta } from "@/lib/result-cache";

// 곡 넣기 화면. 파일을 받으면 다음 단계로 넘긴다. 2차-2: 아래에 "저장된 곡"
// 목록(있을 때만) — 클릭 시 재분리 없이 즉시 연습, × 로 지우기.
export default function UploadView({
  onFileSelected,
  onOpenCached,
  error,
}: {
  onFileSelected: (file: File) => void;
  onOpenCached: (hash: string, name: string) => void;
  error?: string | null;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [songs, setSongs] = useState<SongMeta[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listSongs().then(setSongs).catch(() => setSongs([]));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  function openPicker() {
    inputRef.current?.click();
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileSelected(file);
  }
  function fmt(sec: number): string {
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  async function remove(hash: string) {
    try {
      await deleteSong(hash);
    } finally {
      refresh();
    }
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
      </div>

      {/* 저장된 곡 — 있을 때만 (DESIGN.md: 비면 아무것도 안 보임) */}
      {songs.length > 0 && (
        <div style={{ margin: "var(--space-6) 0 0" }}>
          <p
            style={{
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "0.02em",
              color: "var(--color-text-muted)",
              margin: "0 0 var(--space-3)",
            }}
          >
            저장된 곡 — 다시 분리 없이 바로 시작
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            {songs.map((s) => (
              <div
                key={s.hash}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  background: "var(--color-surface-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-3) var(--space-4)",
                }}
              >
                <button
                  type="button"
                  onClick={() => onOpenCached(s.hash, s.name)}
                  title="이 곡으로 바로 연습"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--color-text-secondary)",
                    fontSize: "15px",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.name}
                </button>
                <span
                  style={{
                    fontSize: "13px",
                    color: "var(--color-text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                  }}
                >
                  {fmt(s.durationSec)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(s.hash)}
                  aria-label={`${s.name} 지우기`}
                  title="지우기"
                  style={{
                    flexShrink: 0,
                    width: "28px",
                    height: "28px",
                    lineHeight: "26px",
                    background: "none",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-full)",
                    color: "var(--color-text-muted)",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
