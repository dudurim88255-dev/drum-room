"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import UploadView from "@/components/UploadView";
import SeparatingView, { type SepSource } from "@/components/SeparatingView";
import PracticeView from "@/components/PracticeView";
import { checkSupport } from "@/lib/env-support";
import { getBpmAnalyzer, type BpmState } from "@/lib/bpm-analyzer";

// 단일 페이지 + 세 화면을 stage 로 전환. 4-C: 실제 곡 분리 → 연습.
// 2차-2: source 는 새 파일 또는 저장된(캐시) 곡 — SeparatingView 가 양쪽 처리.
type Stage = "upload" | "separating" | "practice";

// 클라이언트 전용 능력 감지를 하이드레이션 안전하게(서버=null → "checking").
const noopSubscribe = () => () => {};
let supportCache: boolean | null = null;
function getSupportSnapshot(): boolean {
  if (supportCache === null) supportCache = checkSupport().ok;
  return supportCache;
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [source, setSource] = useState<SepSource | null>(null);
  const [drumVolume, setDrumVolume] = useState(25);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sepError, setSepError] = useState<string | null>(null);
  // null = 서버/하이드레이션 시점("checking"), 이후 클라이언트에서 boolean
  const supported = useSyncExternalStore(
    noopSubscribe,
    getSupportSnapshot,
    () => null as boolean | null,
  );

  // 좌상단 BPM 칩 — PracticeView/메트로놈 패널과 동일 bpm-analyzer 싱글턴을
  // 구독해 같은 값(자동 감지 + 사용자 보정 ÷2/×2/탭/-/+ 반영)을 표시. 칩은
  // 연습 화면 + BPM 값이 있을 때(ready 또는 userTouched)만 렌더, 그 외 숨김.
  const analyzer = getBpmAnalyzer();
  const [bpmState, setBpmState] = useState<BpmState>(() => analyzer.getState());
  useEffect(() => analyzer.subscribe(setBpmState), [analyzer]);
  const showBpmChip =
    stage === "practice" &&
    (bpmState.status === "ready" || bpmState.userTouched);

  const handleFileSelected = useCallback((picked: File) => {
    setSepError(null);
    setSource({ kind: "file", file: picked });
    setStage("separating");
  }, []);

  const handleOpenCached = useCallback((hash: string, name: string) => {
    setSepError(null);
    setSource({ kind: "cached", hash, name });
    setStage("separating");
  }, []);

  const handleSeparationDone = useCallback(() => {
    setStage("practice");
  }, []);

  const handleSeparationError = useCallback((msg: string) => {
    setSepError(msg);
    setSource(null);
    setStage("upload");
  }, []);

  // 2차-7: 연습 중 다른 곡으로. PracticeView 언마운트 cleanup 이 자동으로
  // 재생/카운트인/메트로놈 정지·구독 해제 → 새 곡 진입 시 자연 초기화.
  const handleChangeSong = useCallback(() => {
    setSepError(null);
    setSource(null);
    setStage("upload");
  }, []);

  const title =
    source?.kind === "file"
      ? source.file.name
      : source?.kind === "cached"
        ? source.name
        : null;

  return (
    <main
      style={{
        position: "relative",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-12) var(--space-4)",
        gap: "var(--space-8)",
      }}
    >
      {/* 워드마크 + BPM 메타 — 좌측 상단. 도구/콘솔 정체성.
          BPM 칩은 연습 화면 + bpm-analyzer ready/userTouched 일 때만 렌더
          (분리 전·분리 중·BPM 값 없음 = 숨김). 값은 PracticeView/메트로놈
          패널과 동일 싱글턴 구독 → ÷2/×2/탭/-/+ 보정 실시간 반영. */}
      <div
        style={{
          position: "absolute",
          top: "var(--space-8)",
          left: "var(--space-8)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <span
          aria-label="drum.room"
          className="gold-text"
          style={{
            fontSize: "20px",
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: "-0.01em",
          }}
        >
          drum.room
        </span>
        {showBpmChip && (
          <span
            aria-label={`BPM ${bpmState.bpm}`}
            style={{
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "13px",
              fontWeight: 500,
              lineHeight: 1,
              letterSpacing: "0.02em",
              color: "var(--color-text-muted)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-1) var(--space-2)",
            }}
          >
            BPM {bpmState.bpm}
          </span>
        )}
      </div>

      {/* 소개 카피 — 헤드라인 자리에 단독으로. 시각적 1순위 텍스트.
          골드 그라데이션으로 워드마크와 정체성 묶기. upload 단계 전용. */}
      {stage === "upload" && supported !== false && (
        <div
          style={{
            width: "100%",
            maxWidth: "560px",
            textAlign: "center",
            wordBreak: "keep-all",
          }}
        >
          <h1
            className="gold-text"
            style={{
              fontSize: "30px",
              fontWeight: 600,
              lineHeight: 1.3,
              letterSpacing: "-0.01em",
              margin: 0,
            }}
          >
            AI가 곡에서 드럼을 분리하고, 원곡 위에서 연습합니다.
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "var(--color-text-muted)",
              margin: "var(--space-6) 0 0",
            }}
          >
            파일은 브라우저 밖으로 나가지 않습니다.
          </p>
        </div>
      )}

      <div
        style={{
          width: "100%",
          // 연습 화면만 가로 공간을 써 2열 배치(세로 단축). 곡 넣기·분리
          // 중·미지원 안내는 1차 그대로 560px(DESIGN.md §5 콘텐츠 폭).
          maxWidth: stage === "practice" ? "880px" : "560px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-md)",
          padding: "var(--space-8)",
        }}
      >
        {supported === false ? (
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
              드럼룸은 데스크톱 크롬에 맞춰져 있습니다
            </h2>
            <p
              style={{
                fontSize: "16px",
                lineHeight: 1.7,
                color: "var(--color-text-secondary)",
                margin: "var(--space-4) 0 0",
              }}
            >
              브라우저 안에서 곡을 분리하려면 데스크톱 Chrome 으로 열어 주세요.
              (모바일·일부 브라우저는 1차 지원 범위 밖입니다.)
            </p>
          </div>
        ) : supported === null ? (
          <div
            style={{
              minHeight: "120px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-text-muted)",
              fontSize: "14px",
            }}
          >
            …
          </div>
        ) : (
          <>
            {stage === "upload" && (
              <UploadView
                onFileSelected={handleFileSelected}
                onOpenCached={handleOpenCached}
                error={sepError}
              />
            )}
            {stage === "separating" && source && (
              <SeparatingView
                source={source}
                onDone={handleSeparationDone}
                onError={handleSeparationError}
              />
            )}
            {stage === "practice" && (
              <PracticeView
                fileName={title}
                drumVolume={drumVolume}
                setDrumVolume={setDrumVolume}
                isPlaying={isPlaying}
                setIsPlaying={setIsPlaying}
                onChangeSong={handleChangeSong}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}
