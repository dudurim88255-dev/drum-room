"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
} from "react";
import { getAudioEngine } from "@/lib/audio-engine";
import { getMetronome } from "@/lib/metronome";
import { getBpmAnalyzer, type BpmState } from "@/lib/bpm-analyzer";

const COUNTIN_PREF_KEY = "drumroom.countIn"; // 전역 사용자 선호(곡 무관)
const COUNTIN_BARS = 2; // 카운트인 마디 수 기본

// 1차 메인 화면 + 2차-3(타임라인·구간 반복) + 2차-4(메트로놈).
// 2차-5: 기능 무변경, 레이아웃만 — 곡 컨트롤 2열(주) + 메트로놈 접이식(곁다리)
// → 평소(접힘) 한 화면에 들어오고, 곡 컨트롤이 시각적으로 주가 된다.
const PRESETS = [
  { label: "드럼없이", value: 0 },
  { label: "가이드", value: 25 },
  { label: "원곡", value: 100 },
] as const;

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  letterSpacing: "0.02em",
  color: "var(--color-text-secondary)",
};
const bigNumStyle: CSSProperties = {
  fontSize: "28px",
  fontWeight: 600,
  lineHeight: 1,
  color: "var(--color-accent)",
  fontVariantNumeric: "tabular-nums",
};

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
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  // 메트로놈 — 곡 재생과 독립(별도 모듈, 컨텍스트만 공유)
  const metroRef = useRef(getMetronome());
  const [metroOn, setMetroOn] = useState(false);
  const [metroExpanded, setMetroExpanded] = useState(false); // 접이식(기본 접힘)
  const [metroVol, setMetroVol] = useState(70);
  // 2차-6: BPM/박자/다운비트는 bpm-analyzer 가 단일 진실원천(자동 감지 +
  // 사용자 보정 + 캐시 영구 저장 모두 그쪽). 이 컴포넌트는 구독 + 위임만.
  // 싱글턴이라 매 렌더마다 같은 인스턴스 반환 — ref 불필요(렌더 중 ref 접근
  // 경고 회피).
  const analyzer = getBpmAnalyzer();
  const [bpmState, setBpmState] = useState<BpmState>(() => analyzer.getState());
  // 카운트인 — 전역 선호(localStorage), 진행 중 상태, 취소 핸들.
  const [countInEnabled, setCountInEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage?.getItem(COUNTIN_PREF_KEY);
    return v == null ? true : v === "1";
  });
  const [countInActive, setCountInActive] = useState(false);
  const countInCancelRef = useRef<(() => void) | null>(null);
  // 탭 템포 — 최근 탭 시각들(s), 3초 무탭 시 리셋
  const tapTimesRef = useRef<number[]>([]);

  useEffect(() => {
    const engine = engineRef.current;
    engine.setDrumVolume(drumVolume / 100);
    setDuration(engine.getDuration());
    setPosition(engine.getPosition());
    // 끝까지 가면 자동 정지(엔진이 플레이헤드 0 으로 리셋) → 버튼·표시 동기화
    engine.setOnEnded(() => {
      setIsPlaying(false);
      setPosition(0);
    });
    const metro = metroRef.current;
    // 2차-6: BPM 분석/사용자 보정 상태 구독(자동 결과 도착 또는 영구 보정값
    // 로드 시 UI 가 따라온다 — 분석은 SeparatingView 에서 이미 가동됨).
    const unsubBpm = analyzer.subscribe(setBpmState);
    return () => {
      engine.setOnEnded(null);
      engine.stop();
      setIsPlaying(false);
      metro.stop();
      countInCancelRef.current?.(); // 진행 중 카운트인 깔끔히 취소
      countInCancelRef.current = null;
      unsubBpm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BPM/박자가 바뀌면 메트로놈(사용자 토글로 울리는 쪽) 도 즉시 동기화
  useEffect(() => {
    metroRef.current.setBpm(bpmState.bpm);
  }, [bpmState.bpm]);
  useEffect(() => {
    metroRef.current.setBeatsPerBar(bpmState.beatsPerBar);
  }, [bpmState.beatsPerBar]);

  // 재생 중에만 rAF 로 위치 갱신(정지 시 멈춤 — 불필요한 렌더 방지)
  useEffect(() => {
    if (!isPlaying) return;
    const engine = engineRef.current;
    const tick = () => {
      setPosition(engine.getPosition());
      if (!engine.isPlaying) setIsPlaying(false);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  async function togglePlay() {
    const engine = engineRef.current;
    // 1) 카운트인 중 = 정지 버튼 → 취소(곡 시작 안 함, 위치 보존)
    if (countInActive) {
      countInCancelRef.current?.();
      countInCancelRef.current = null;
      setCountInActive(false);
      return;
    }
    // 2) 곡 재생 중 → 정지(위치 보존, 기존 동작)
    if (engine.isPlaying) {
      engine.stop();
      setIsPlaying(false);
      setPosition(engine.getPosition());
      return;
    }
    // 3) 정지 상태에서 시작
    if (!countInEnabled) {
      await engine.play(); // 카운트인 비활성 — 즉시 재생(기존 동작)
      setIsPlaying(engine.isPlaying);
      return;
    }
    // 4) 카운트인 켜짐 — 곡 박자 그리드에 스냅 후 카운트인→곡 정렬
    const bpm = bpmState.bpm;
    const beats = bpmState.beatsPerBar;
    const downbeat = bpmState.downbeatOffsetSec;
    const P = 60 / bpm;
    const playhead = engine.getPosition();
    const dur = engine.getDuration();
    // snapOffset = 다운비트 기준 다음 박 경계(=곡의 1박 ↔ 마지막 카운트 박)
    const k = Math.ceil(Math.max(0, playhead - downbeat) / P);
    const snapOffset = Math.min(dur, downbeat + k * P);
    setCountInActive(true);
    const handle = metroRef.current.playCountIn({
      bpm,
      beatsPerBar: beats,
      bars: COUNTIN_BARS,
      onDone: (songStart) => {
        setCountInActive(false);
        countInCancelRef.current = null;
        void engineRef.current.playAt(songStart, snapOffset).then(() => {
          setIsPlaying(engineRef.current.isPlaying);
          setPosition(snapOffset);
        });
      },
    });
    countInCancelRef.current = handle.cancel;
  }

  function applyVolume(v: number) {
    setDrumVolume(v);
    engineRef.current.setDrumVolume(v / 100);
  }

  // 메트로놈 핸들러 — 곡 재생/구간반복과 무관(별도 출력 체인)
  async function toggleMetro() {
    const m = metroRef.current;
    const next = !metroOn;
    setMetroOn(next);
    if (next) await m.start();
    else m.stop();
  }
  // 모든 보정은 analyzer 로 위임(=곡별 영구 저장 + emit → 메트로놈/UI 동기).
  function changeBpm(v: number) {
    analyzer.setUserBpm(v);
  }
  function changeBeats(delta: number) {
    analyzer.setBeatsPerBar(bpmState.beatsPerBar + delta);
  }
  function changeMetroVol(v: number) {
    setMetroVol(v);
    metroRef.current.setVolume(v / 100);
  }
  // 2차-6 보정 액션
  function bpmHalf() {
    analyzer.setUserBpm(bpmState.bpm / 2);
  }
  function bpmDouble() {
    analyzer.setUserBpm(bpmState.bpm * 2);
  }
  function setDownbeatHere() {
    analyzer.setDownbeatOffsetSec(engineRef.current.getPosition());
  }
  function tapTempo() {
    // 클릭 시각(초) 누적, 3초 이상 간격이면 리셋. 최근 4~6개 평균 → BPM.
    const now = performance.now() / 1000;
    const arr = tapTimesRef.current;
    if (arr.length > 0 && now - arr[arr.length - 1] > 3) arr.length = 0;
    arr.push(now);
    if (arr.length > 6) arr.shift();
    if (arr.length >= 2) {
      const span = arr[arr.length - 1] - arr[0];
      const bpm = (60 * (arr.length - 1)) / span;
      analyzer.setUserBpm(bpm);
    }
  }
  function toggleCountIn() {
    const next = !countInEnabled;
    setCountInEnabledState(next);
    try {
      window.localStorage?.setItem(COUNTIN_PREF_KEY, next ? "1" : "0");
    } catch {
      /* localStorage 무가용 환경 — 세션 한정 동작 */
    }
  }

  const tFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return ratio * duration;
    },
    [duration],
  );

  function seekTo(t: number) {
    engineRef.current.seek(t);
    setPosition(engineRef.current.getPosition());
  }

  const MIN_LOOP = 0.1; // 최소 구간 길이(초) — engine hasValidLoop 과 일관

  // 구간 A 재탭 = 새 선택 시작: A=현재 위치, B 비움. 엔진엔 적용하지 않음
  // → 직전에 잡혀 있던 구간의 루프가 끊김 없이 계속 돈다(연습 중단 없음).
  function captureA() {
    setLoopA(engineRef.current.getPosition());
    setLoopB(null);
  }
  // B 는 A 이후일 때만 채워지고, 그 순간에만 새 [A,B] 를 한 번에 엔진으로
  // 전환한다. b<=A(루프가 되감겨 A 보다 앞)면 아무것도 하지 않는다 →
  // 교차 상태(loopA>loopB)가 구조적으로 생기지 않음(스왑·순간이동 없음).
  function captureB() {
    if (loopA == null) return; // 선택 시작은 항상 A
    const b = engineRef.current.getPosition();
    if (b - loopA < MIN_LOOP) return; // B 는 A 이후여야 — 역전 무시
    setLoopB(b);
    engineRef.current.setLoopRegion(loopA, b);
  }
  const regionValid =
    loopA != null && loopB != null && loopB - loopA >= MIN_LOOP;
  function toggleLoop() {
    if (!regionValid) return;
    const next = !loopOn;
    setLoopOn(next);
    engineRef.current.setLoopEnabled(next);
  }

  // A/B 마커 드래그 미세조정
  const dragRef = useRef<"A" | "B" | null>(null);
  function onMarkerDown(which: "A" | "B", e: RPointerEvent) {
    e.stopPropagation();
    dragRef.current = which;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMarkerMove(e: RPointerEvent) {
    if (!dragRef.current) return;
    const t = tFromClientX(e.clientX);
    if (dragRef.current === "A") {
      // A 는 B 를 넘지 못하게 막는다(핸들 순간이동/스왑 방지).
      const maxA = (loopB ?? duration) - MIN_LOOP;
      const a = Math.min(Math.max(0, t), Math.max(0, maxA));
      setLoopA(a);
      if (loopB != null && loopB - a >= MIN_LOOP) {
        engineRef.current.setLoopRegion(a, loopB);
      }
    } else {
      const minB = (loopA ?? 0) + MIN_LOOP;
      const b = Math.max(Math.min(duration, t), minB);
      setLoopB(b);
      if (loopA != null && b - loopA >= MIN_LOOP) {
        engineRef.current.setLoopRegion(loopA, b);
      }
    }
  }
  function onMarkerUp(e: RPointerEvent) {
    if (!dragRef.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);
  // 캡처/드래그가 A≤B 를 보장 → 정렬-스왑 불필요(핸들 순간이동 제거).
  const rA = loopA;
  const rB = loopB;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6)",
        width: "100%",
      }}
    >
      {/* 곡 제목 */}
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

      {/* 곡 컨트롤(주) — 2열: 좌 재생/타임라인/구간, 우 드럼 볼륨/프리셋 */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-8)",
          alignItems: "flex-start",
          flexWrap: "wrap",
          width: "100%",
        }}
      >
        {/* 좌: 트랜스포트(재생/정지 + 타임라인) + 구간 */}
        <div
          style={{
            flex: "1 1 360px",
            minWidth: "320px",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-6)",
              width: "100%",
            }}
          >
            <button
              type="button"
              className="action-btn"
              data-playing={isPlaying || countInActive}
              aria-label={
                isPlaying || countInActive ? "정지" : "재생"
              }
              title={countInActive ? "카운트인 — 다시 누르면 취소" : undefined}
              onClick={togglePlay}
              style={{ flexShrink: 0 }}
            >
              {isPlaying || countInActive ? <StopIcon /> : <PlayIcon />}
            </button>

            {/* 타임라인 — 곡 전체 + 현재 위치 + A~B 구간. 클릭=seek */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                ref={trackRef}
                role="slider"
                aria-label="재생 위치"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(position)}
                tabIndex={0}
                onClick={(e) => seekTo(tFromClientX(e.clientX))}
                onPointerMove={onMarkerMove}
                onPointerUp={onMarkerUp}
                style={{
                  position: "relative",
                  height: "28px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  touchAction: "none",
                }}
              >
                {/* 트랙 홈 */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    height: "8px",
                    background: "var(--color-surface-inset)",
                    borderRadius: "var(--radius-full)",
                  }}
                />
                {/* A~B 구간(연습 창) — accent-dim */}
                {rA != null && rB != null && (
                  <div
                    style={{
                      position: "absolute",
                      left: `${pct(rA)}%`,
                      width: `${Math.max(0, pct(rB) - pct(rA))}%`,
                      height: "8px",
                      background: "var(--color-accent-dim)",
                      borderRadius: "var(--radius-full)",
                      opacity: loopOn ? 1 : 0.6,
                    }}
                  />
                )}
                {/* 플레이헤드 — 단 하나의 '살아있는' 요소: accent */}
                <div
                  style={{
                    position: "absolute",
                    left: `calc(${pct(position)}% - 1px)`,
                    width: "2px",
                    height: "18px",
                    background: "var(--color-accent)",
                    borderRadius: "1px",
                  }}
                />
                {/* A/B 마커(드래그 미세조정) */}
                {rA != null && (
                  <Handle
                    pos={pct(rA)}
                    label="A"
                    onDown={(e) => onMarkerDown("A", e)}
                  />
                )}
                {rB != null && (
                  <Handle
                    pos={pct(rB)}
                    label="B"
                    onDown={(e) => onMarkerDown("B", e)}
                  />
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: "var(--space-2)",
                  fontSize: "13px",
                  color: "var(--color-text-secondary)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>{fmt(position)}</span>
                <span>{fmt(duration)}</span>
              </div>
            </div>
          </div>

          {/* 구간 지정 + 반복 토글 */}
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <button type="button" className="preset-btn" onClick={captureA}>
              구간 A
            </button>
            <button type="button" className="preset-btn" onClick={captureB}>
              구간 B
            </button>
            <button
              type="button"
              className="preset-btn"
              aria-pressed={loopOn}
              disabled={!regionValid}
              onClick={toggleLoop}
              title={
                regionValid ? "A~B 구간만 반복" : "먼저 구간 A·B 를 잡으세요"
              }
              style={
                !regionValid ? { opacity: 0.5, cursor: "default" } : undefined
              }
            >
              구간 반복 {loopOn ? "⟳ 켜짐" : "꺼짐"}
            </button>
          </div>
        </div>

        {/* 우: 드럼 볼륨 + 프리셋 */}
        <div
          style={{
            flex: "1 1 280px",
            minWidth: "260px",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <div style={{ width: "100%" }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: "var(--space-3)",
              }}
            >
              <span style={labelStyle}>드럼 볼륨</span>
              <span style={bigNumStyle}>{drumVolume}%</span>
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
      </div>

      {/* 메트로놈 — 곁다리: 접이식. 평소 한 줄(켜짐 시 인디케이터), 눌러 펼침 */}
      <div
        style={{
          width: "100%",
          borderTop: "1px solid var(--color-border)",
          paddingTop: "var(--space-3)",
        }}
      >
        <button
          type="button"
          aria-expanded={metroExpanded}
          aria-controls="metro-panel"
          onClick={() => setMetroExpanded((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: "var(--space-4)",
            background: "none",
            border: "none",
            padding: "var(--space-2) 0",
            cursor: "pointer",
            // 곡 컨트롤보다는 덜 강조하되 또렷이 읽히게(muted→secondary)
            color: "var(--color-text-secondary)",
          }}
        >
          {/* 라벨 + 펼침/접힘 표시를 한 덩어리로(눌러서 펼치는 묶음) */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "0.02em",
            }}
          >
            메트로놈
            <span aria-hidden style={{ fontSize: "12px" }}>
              {metroExpanded ? "▴ 접기" : "▾ 펼치기"}
            </span>
          </span>
          {metroOn && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                color: "var(--color-accent)",
                fontVariantNumeric: "tabular-nums",
                fontSize: "13px",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "var(--radius-full)",
                  background: "var(--color-accent)",
                }}
              />
              켜짐 · {bpmState.bpm} BPM
            </span>
          )}
        </button>

        {metroExpanded && (
          <div
            id="metro-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
              paddingTop: "var(--space-4)",
            }}
          >
            {/* 메트로놈 on/off (사용자가 곡과 별개로 클릭 듣고 싶을 때) */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={labelStyle}>곡과 별개로 박자 클릭</span>
              <button
                type="button"
                className="preset-btn"
                aria-pressed={metroOn}
                onClick={toggleMetro}
              >
                {metroOn ? "⏻ 켜짐" : "꺼짐"}
              </button>
            </div>

            {/* BPM: 큰 숫자 + −/＋ + ×2/÷2. 아래에 감지 라벨(자동값과 다를 때). */}
            <div style={{ width: "100%" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "var(--space-3)",
                  flexWrap: "wrap",
                  gap: "var(--space-3)",
                }}
              >
                <span style={labelStyle}>BPM</span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3)",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="preset-btn"
                    aria-label="BPM 감소"
                    onClick={() => changeBpm(bpmState.bpm - 1)}
                  >
                    −
                  </button>
                  <span
                    style={{
                      ...bigNumStyle,
                      minWidth: "3ch",
                      textAlign: "center",
                    }}
                  >
                    {bpmState.bpm}
                  </span>
                  <button
                    type="button"
                    className="preset-btn"
                    aria-label="BPM 증가"
                    onClick={() => changeBpm(bpmState.bpm + 1)}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="preset-btn"
                    aria-label="BPM 절반"
                    title="절반/두 배 오감지 보정"
                    onClick={bpmHalf}
                  >
                    ÷2
                  </button>
                  <button
                    type="button"
                    className="preset-btn"
                    aria-label="BPM 두 배"
                    title="절반/두 배 오감지 보정"
                    onClick={bpmDouble}
                  >
                    ×2
                  </button>
                </span>
              </div>
              <input
                type="range"
                className="drum-slider"
                min={40}
                max={240}
                value={bpmState.bpm}
                aria-label="BPM"
                onChange={(e) => changeBpm(Number(e.target.value))}
                style={
                  {
                    ["--fill"]: `${((bpmState.bpm - 40) / 200) * 100}%`,
                  } as CSSProperties
                }
              />
              {/* 자동 감지 부가 표시 — 사용자값과 다르거나 분석 중·실패일 때만 */}
              {(bpmState.status === "pending" ||
                bpmState.status === "failed" ||
                (bpmState.bpmDetected != null &&
                  bpmState.bpmDetected !== bpmState.bpm)) && (
                <p
                  style={{
                    margin: "var(--space-2) 0 0",
                    fontSize: "12px",
                    color: "var(--color-text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {bpmState.status === "pending"
                    ? "BPM 분석 중…"
                    : bpmState.status === "failed"
                      ? "BPM 자동 감지 실패 — 수동으로 맞춰 주세요"
                      : `감지: ${bpmState.bpmDetected} BPM`}
                </p>
              )}
            </div>

            {/* 박자 + 다운비트(여기를 첫 박) */}
            <div
              style={{
                display: "flex",
                gap: "var(--space-6)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                }}
              >
                <span style={labelStyle}>박자</span>
                <button
                  type="button"
                  className="preset-btn"
                  aria-label="박자 감소"
                  onClick={() => changeBeats(-1)}
                >
                  −
                </button>
                <span
                  style={{
                    fontSize: "15px",
                    color: "var(--color-text)",
                    fontVariantNumeric: "tabular-nums",
                    minWidth: "2ch",
                    textAlign: "center",
                  }}
                >
                  {bpmState.beatsPerBar}
                </span>
                <button
                  type="button"
                  className="preset-btn"
                  aria-label="박자 증가"
                  onClick={() => changeBeats(1)}
                >
                  ＋
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                }}
              >
                <span style={labelStyle}>
                  첫 박:{" "}
                  <span
                    style={{
                      color: "var(--color-text)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmt(bpmState.downbeatOffsetSec)}
                  </span>
                </span>
                <button
                  type="button"
                  className="preset-btn"
                  onClick={setDownbeatHere}
                  title="현재 재생 위치를 곡의 첫 박으로 — 카운트인 정렬용"
                >
                  여기를 첫 박
                </button>
              </div>
            </div>

            {/* 탭 템포 + 카운트인 토글 + 메트로놈 볼륨 */}
            <div
              style={{
                display: "flex",
                gap: "var(--space-6)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="preset-btn"
                onClick={tapTempo}
                title="박자에 맞춰 눌러서 BPM 설정"
              >
                탭 템포
              </button>
              <button
                type="button"
                className="preset-btn"
                aria-pressed={countInEnabled}
                onClick={toggleCountIn}
                title={`재생 전 ${COUNTIN_BARS}마디 카운트인`}
              >
                카운트인 {countInEnabled ? "⏻ 켜짐" : "꺼짐"}
              </button>
              <div style={{ flex: 1, minWidth: "180px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  <span style={labelStyle}>메트로놈 볼륨</span>
                  <span
                    style={{
                      fontSize: "13px",
                      color: "var(--color-text-secondary)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {metroVol}%
                  </span>
                </div>
                <input
                  type="range"
                  className="drum-slider"
                  min={0}
                  max={100}
                  value={metroVol}
                  aria-label="메트로놈 볼륨"
                  onChange={(e) => changeMetroVol(Number(e.target.value))}
                  style={{ ["--fill"]: `${metroVol}%` } as CSSProperties}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Handle({
  pos,
  label,
  onDown,
}: {
  pos: number;
  label: string;
  onDown: (e: RPointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onDown}
      aria-label={`구간 ${label} 조정`}
      style={{
        position: "absolute",
        left: `calc(${pos}% - 7px)`,
        width: "14px",
        height: "22px",
        background: "var(--color-accent)",
        border: "2px solid var(--color-bg)",
        borderRadius: "var(--radius-sm)",
        cursor: "ew-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "10px",
        fontWeight: 700,
        color: "var(--color-bg)",
      }}
    >
      {label}
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
