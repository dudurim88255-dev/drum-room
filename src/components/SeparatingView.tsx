"use client";

import { useEffect, useRef, useState } from "react";
import { loadModel, type ModelProgress } from "@/lib/model-cache";
import { decodeAudioFile, separate } from "@/lib/separation-engine";
import { getAudioEngine } from "@/lib/audio-engine";

// 분리 중 화면 (4-C: 진짜). 모델 1회 다운로드(진행률)+캐시 → 곡 분리
// (Web Worker, 청크 N/M 진행률) → 결과 두 트랙을 재생 엔진에 주입.
type UI = { headline: string; pct: number; detail: string };

export default function SeparatingView({
  file,
  onDone,
  onError,
}: {
  file: File;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [ui, setUi] = useState<UI>({
    headline: "준비 중…",
    pct: 0,
    detail: "",
  });
  // StrictMode 이중 마운트 + 무거운 작업 → 1회만 실행.
  // 주의: cleanup 에서 cancel 플래그를 세우는 패턴은 StrictMode 에서
  // (setup→cleanup→setup) 1차 cleanup 이 유일한 async 를 죽인다. 그래서
  // 취소 플래그를 두지 않고, 종료 콜백만 doneRef 로 1회 가드한다.
  const startedRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const ab = await file.arrayBuffer();

      // 0) 디코드 먼저 — 잘못된 파일이면 163MB 모델 받기 전에 빠르게 실패
      setUi({ headline: "파일 읽는 중", pct: 0, detail: "" });
      const pcm = await decodeAudioFile(ab);

      // 1) 모델 (첫 방문 1회 다운로드 + 캐시, 이후 즉시)
      const onModel = (p: ModelProgress) => {
        if (p.phase === "download") {
          setUi({
            headline: "모델 다운로드 (첫 방문 1회)",
            pct: Math.round((p.loaded / p.total) * 100),
            detail: `${(p.loaded / 1048576).toFixed(0)} / ${(
              p.total / 1048576
            ).toFixed(0)} MB`,
          });
        } else if (p.phase === "verify" || p.phase === "cache") {
          setUi({ headline: "모델 준비 중", pct: 100, detail: "무결성 검증" });
        }
      };
      const { bytes } = await loadModel(onModel);

      // 2) 분리 (Web Worker, 청크 진행률)
      setUi({ headline: "드럼 분리 중", pct: 0, detail: "세그먼트 0/—" });
      const engine = getAudioEngine();
      const { drumsBuffer, backingBuffer } = await separate(pcm, bytes, {
        audioContext: engine.getContext(), // 단일 컨텍스트 유지
        onProgress: (chunk, totalChunks) => {
          setUi({
            headline: "드럼 분리 중",
            pct: Math.round((chunk / totalChunks) * 100),
            detail: `세그먼트 ${chunk}/${totalChunks}`,
          });
        },
      });

      // 3) 결과를 3단계 재생 엔진에 주입 → 연습 화면
      engine.loadBuffers(drumsBuffer, backingBuffer);
      if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    })().catch((e: unknown) => {
      if (doneRef.current) return;
      doneRef.current = true;
      const msg = e instanceof Error ? e.message : String(e);
      // 단계로 정확히 분류: 디코드 실패(AudioDecodeError)만 "파일 못 엶".
      // 그 외(모델/worker/ort)는 원문을 그대로 보여 오분류·오진단 방지.
      const isDecode =
        e instanceof Error && (e as { code?: string }).code === "AUDIO_DECODE";
      onError(
        isDecode
          ? "이 파일은 열 수 없습니다. 다른 음원(mp3/wav/flac/m4a)을 넣어 주세요."
          : `분리 실패: ${msg}`,
      );
    });
    // file 은 마운트 시 고정. onDone/onError 는 안정 참조(부모 useCallback).
    // cleanup 없음(StrictMode 에서 async 를 죽이지 않기 위함).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ textAlign: "center" }}>
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
        {ui.headline}{" "}
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{ui.pct}%</span>
      </h2>

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
            width: `${ui.pct}%`,
            background: "var(--color-accent)",
            borderRadius: "var(--radius-full)",
            transition: "width 300ms ease",
          }}
        />
      </div>

      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-secondary)",
          margin: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {ui.detail}
      </p>

      <p
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
          margin: "var(--space-6) 0 0",
        }}
      >
        분리는 곡 길이에 따라 시간이 걸립니다. 화면을 닫지 마세요.
      </p>
    </div>
  );
}
