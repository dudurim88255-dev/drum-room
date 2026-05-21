"use client";

import { useEffect, useRef, useState } from "react";
import { loadModel, type ModelProgress } from "@/lib/model-cache";
import { decodeAudioFile, separate } from "@/lib/separation-engine";
import { getAudioEngine } from "@/lib/audio-engine";
import {
  hashFile,
  getCachedSong,
  saveSong,
  type RestoredSong,
} from "@/lib/result-cache";
import { getBpmAnalyzer } from "@/lib/bpm-analyzer";

// 분리 중 화면. 2차-2: 먼저 결과 캐시(IndexedDB)를 확인 — 같은 곡이면
// ~8분30초 재분리를 건너뛰고 저장된 트랙을 즉시 재생 엔진에 주입.
// 캐시 미스만 기존 흐름(디코드 → 모델 → worker 분리) → 끝나면 저장.
export type SepSource =
  | { kind: "file"; file: File }
  | { kind: "cached"; hash: string; name: string };

type UI = { headline: string; pct: number; detail: string };

function injectRestored(r: RestoredSong): void {
  const engine = getAudioEngine();
  const ctx = engine.getContext();
  const drums = ctx.createBuffer(2, r.length, r.sampleRate);
  drums.getChannelData(0).set(r.dL);
  drums.getChannelData(1).set(r.dR);
  const backing = ctx.createBuffer(2, r.length, r.sampleRate);
  backing.getChannelData(0).set(r.bL);
  backing.getChannelData(1).set(r.bR);
  engine.loadBuffers(drums, backing);
}

export default function SeparatingView({
  source,
  onDone,
  onError,
}: {
  source: SepSource;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [ui, setUi] = useState<UI>({
    headline: "준비 중…",
    pct: 0,
    detail: "",
  });
  // StrictMode 이중 마운트 가드: 시작 1회 + 종료 1회 (4-C 교훈).
  const startedRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone();
    };

    (async () => {
      // 목록에서 연 캐시 곡: 파일 없이 바로 복원
      if (source.kind === "cached") {
        setUi({ headline: "저장된 곡 불러오는 중", pct: 0, detail: "" });
        const r = await getCachedSong(source.hash);
        if (!r) throw new Error("저장된 곡을 찾을 수 없습니다");
        injectRestored(r);
        // 2차-6: BPM 분석/사용자 보정 메타 동기화(캐시 히트면 worker 미가동)
        void getBpmAnalyzer().setCurrentSong(source.hash, {
          drumsL: r.dL,
          drumsR: r.dR,
          sampleRate: r.sampleRate,
        });
        finish();
        return;
      }

      const ab = await source.file.arrayBuffer();

      // 0) 결과 캐시 확인 — 같은 곡이면 재분리 스킵(이게 2차-2 핵심)
      setUi({ headline: "파일 확인 중", pct: 0, detail: "" });
      const hash = await hashFile(ab);
      const cached = await getCachedSong(hash);
      if (cached) {
        setUi({ headline: "이미 분리된 곡 — 바로 시작", pct: 100, detail: "" });
        injectRestored(cached);
        // 2차-6: 캐시 히트 — 메타에 BPM 있으면 즉시 ready, 없으면 분석 1회.
        void getBpmAnalyzer().setCurrentSong(hash, {
          drumsL: cached.dL,
          drumsR: cached.dR,
          sampleRate: cached.sampleRate,
        });
        finish();
        return;
      }

      // 1) 디코드 (잘못된 파일이면 163MB 모델 받기 전에 빠르게 실패)
      setUi({ headline: "파일 읽는 중", pct: 0, detail: "" });
      const pcm = await decodeAudioFile(ab);

      // 2) 모델 (첫 방문 1회 다운로드 + 캐시)
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

      // 3) 분리 (Web Worker, 청크 진행률) — 기존 로직 그대로
      setUi({ headline: "드럼 분리 중", pct: 0, detail: "세그먼트 0/—" });
      const engine = getAudioEngine();
      const { drumsBuffer, backingBuffer } = await separate(pcm, bytes, {
        audioContext: engine.getContext(),
        onProgress: (chunk, totalChunks) => {
          setUi({
            headline: "드럼 분리 중",
            pct: Math.round((chunk / totalChunks) * 100),
            detail: `세그먼트 ${chunk}/${totalChunks}`,
          });
        },
      });

      // 4) 재생 엔진 주입 + 결과 저장(best-effort: 실패해도 흐름 계속)
      engine.loadBuffers(drumsBuffer, backingBuffer);
      setUi({ headline: "결과 저장 중", pct: 100, detail: "다음엔 즉시 시작" });
      // 2차-6: BPM 분석을 백그라운드로(saveSong 후 메타에 합쳐짐). slice() 로
      // 독립 Float32 사본 떼어 worker 로 transferable(원본 AudioBuffer 무영향).
      void getBpmAnalyzer().setCurrentSong(hash, {
        drumsL: drumsBuffer.getChannelData(0).slice(0),
        drumsR: drumsBuffer.getChannelData(1).slice(0),
        sampleRate: drumsBuffer.sampleRate,
      });
      try {
        await saveSong(
          { hash, name: source.file.name },
          drumsBuffer,
          backingBuffer,
        );
      } catch {
        // 저장은 "있으면 좋은" 부가기능 — 실패해도 분리·연습은 정상 진행
      }
      finish();
    })().catch((e: unknown) => {
      if (doneRef.current) return;
      doneRef.current = true;
      const msg = e instanceof Error ? e.message : String(e);
      // 디코드 실패(AudioDecodeError)만 "파일 못 엶". 그 외 원문 표시.
      const isDecode =
        e instanceof Error && (e as { code?: string }).code === "AUDIO_DECODE";
      onError(
        isDecode
          ? "이 파일은 열 수 없습니다. 다른 음원(mp3/wav/flac/m4a)을 넣어 주세요."
          : `분리 실패: ${msg}`,
      );
    });
    // source 는 마운트 시 고정. onDone/onError 는 부모 useCallback 안정 참조.
    // cleanup 없음(StrictMode 에서 async 를 죽이지 않기 위함 — 4-C 교훈).
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

      {/* 첫 방문 모델 다운로드일 때만 — 처음 한 번뿐임을 안내(친절) */}
      {ui.headline.startsWith("모델 다운로드") && (
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.6,
            color: "var(--color-text-muted)",
            margin: "var(--space-4) 0 0",
          }}
        >
          분리 엔진(AI 모델)을 처음 한 번만 내려받습니다 · 약 160MB ·
          다음부터는 받지 않아요.
        </p>
      )}

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
