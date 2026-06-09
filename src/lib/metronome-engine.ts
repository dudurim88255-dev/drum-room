// 헤드리스 메트로놈 엔진 — 2차-9 Step 1(헤드리스+Two Clocks+풀링) + Step 2(박자 모델).
//
// Step 1 lock 유지:
// - L1 헤드리스 본체 / L6 Two Clocks Worker 타이머 + 비주얼 분리 + 클릭 풀링.
// - 클릭음: OfflineAudioContext 사전 렌더 AudioBuffer, 박마다 AudioBufferSourceNode.
// - prefs(version, volume) 영속, 다른 필드는 Step 3.
//
// Step 2 추가(라이브 PracticeView 호출 0 = 휴면 — §5 곡-미러 유지):
// - L4 박자 모델 = metronome-grid PRESET_TABLE(12종) + grouping[] + accents[] + subdivision.
// - L3 펄스 격자 스케줄: t = barStartTime + tickIdxInBar × currentSubInterval
//   (multiplicative, 누적합 아님 — Phase A 주의 A). sample-round = round(t×SR)/SR.
// - 정밀 스펙 #2 setMeter/setSubdivision/setAccents 는 **다음 마디 경계 적용**(pending swap).
//   setBpm/setBeatsPerBar 는 **즉시 적용**(라이브 회귀 보호 — Phase A 주의 §5).
// - Cautionary C: 바 advance = 현재 바의 (currentTicksPerBar × currentSubInterval).
//   교체가 일어나도 현재 바는 옛 길이로 끝남.
//
// 4/4 회귀 보장(G1): 기본 상태(meter=4/4 simple-quarter, subdivision=1,
// accents=[3,2,2,2]) → strong/mid/mid/mid 패턴이 Step 1 의 accent/beat 와 비트 동일
// (accentBuf/beatBuf 버퍼 그대로 재사용). 신규 weak/softest 버퍼는 4/4 기본 경로에서
// 미사용.
import { getAudioEngine } from "./audio-engine";
import {
  loadMetronomePrefs,
  saveMetronomePrefs,
} from "./metronome-prefs";
import {
  PRESET_TABLE,
  baseUnitDurSec,
  displayBpmToQuarter,
  defaultAccents,
  makeSimpleQuarterPreset,
  pulseKindAt,
  ticksPerBar as ticksPerBarOf,
  type AccentLevel,
  type MeterPreset,
  type PulseKind,
} from "./metronome-grid";

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;

// 클릭음 합성 파라미터 — Step 1 scheduleClick 와 비트 동일.
// 변경 시 OfflineAudioContext 렌더 결과 변동 → 회귀 — 손대지 말 것.
const CLICK_DURATION = 0.05;
const ATTACK = 0.001;
const RELEASE = 0.04;

// 레벨별 음색(주파수·게인 정점). Step 1 strong/mid 는 기존 1500/900Hz, 게인 1.0 그대로
// → 4/4 회귀 버퍼 비트 동일 보장. weak/softest 는 Step 2 신규(임시값 — Step 3 청취 튜닝).
const ACCENT_HZ = 1500; // strong (Step 1 accent)
const BEAT_HZ = 900; // mid (Step 1 beat)
const WEAK_HZ = 600; // weak (신규)
const SOFTEST_HZ = 400; // softest (신규)
const MAX_GAIN = 0.9;

/**
 * OfflineAudioContext 사전 렌더 — Step 1 의 osc 클릭 합성과 비트 동일.
 * (freq=1500/gainScale=1.0)·(freq=900/gainScale=1.0) 호출은 Step 1 accent/beat 와 동일 버퍼.
 */
async function renderClick(
  sampleRate: number,
  freq: number,
  gainScale: number,
): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(CLICK_DURATION * sampleRate));
  const offline = new OfflineAudioContext(1, len, sampleRate);
  const osc = offline.createOscillator();
  const g = offline.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(gainScale, ATTACK);
  // exponentialRamp 양수 종점 필요 — Step 1 동일 0.0001(=-80dB) 무음 근사.
  g.gain.exponentialRampToValueAtTime(0.0001, RELEASE);
  osc.connect(g);
  g.connect(offline.destination);
  osc.start(0);
  osc.stop(CLICK_DURATION);
  return offline.startRendering();
}

class MetronomeEngine {
  // 오디오 노드 (lazy init)
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private accentBuf: AudioBuffer | null = null; // level 3 strong — Step 1 accent 동일
  private beatBuf: AudioBuffer | null = null; // level 2 mid — Step 1 beat 동일
  private weakBuf: AudioBuffer | null = null; // level 1 weak — Step 2 신규
  private softestBuf: AudioBuffer | null = null; // sub-tick — Step 2 신규
  private bufferInit: Promise<void> | null = null;

  // 사용자 보이는 상태
  private running = false;
  private displayBpm = 120; // 사용자 표시 BPM (1차 저장)
  private quarterBpm = 120; // 내부 4분음표 BPM = displayBpmToQuarter(displayBpm, type)
  private volume = 0.7;

  // 박자 모델 (Step 2). 기본 = 4/4 simple-quarter, subdivision=1, accents=[3,2,2,2].
  // → 4/4 기본 펄스 = strong/mid/mid/mid 로 Step 1 비트 동일.
  private meterPreset: MeterPreset = PRESET_TABLE["4/4"];
  private subdivision = 1;
  private accents: AccentLevel[] = [3, 2, 2, 2];

  // pending swap (다음 마디 경계에 적용 — setMeter/setSubdivision/setAccents 만).
  // setBpm/setBeatsPerBar 는 즉시 적용(라이브 회귀 보호 — 주의 §5).
  private pendingMeter: MeterPreset | null = null;
  private pendingSubdivision: number | null = null;
  private pendingAccents: AccentLevel[] | null = null;

  // 스케줄러 상태 — bar-anchor + tickIdxInBar (Step 2 주의 A·C)
  private worker: Worker | null = null;
  private barStartTime = 0; // 현재 바 시작 시각(ctx 기준 sec)
  private tickIdxInBar = 0; // 0..currentTicksPerBar-1
  // 캐시(setBpm/setBeatsPerBar/swap 마다 갱신)
  private currentSubInterval = 60 / 120; // = baseUnitDurSec(type, q) / subdivision
  private currentTicksPerBar = 4; // = baseCount × subdivision

  constructor() {
    const prefs = loadMetronomePrefs();
    this.volume = prefs.volume;
    this.refreshBarParams();
  }

  /** 캐시(currentSubInterval, currentTicksPerBar) 를 현재 meter/sub/q 로 갱신. */
  private refreshBarParams(): void {
    this.currentSubInterval =
      baseUnitDurSec(this.meterPreset.type, this.quarterBpm) / this.subdivision;
    this.currentTicksPerBar = ticksPerBarOf(this.meterPreset, this.subdivision);
  }

  /** 바 경계에서 호출 — pending 값을 활성 상태로 옮기고 캐시 갱신. */
  private applyPendingSwap(): void {
    if (this.pendingMeter) {
      this.meterPreset = this.pendingMeter;
      this.pendingMeter = null;
      // type 변경 시 q 재계산(표시 숫자 유지, 정밀 스펙 A2)
      this.quarterBpm = displayBpmToQuarter(
        this.displayBpm,
        this.meterPreset.type,
      );
    }
    if (this.pendingSubdivision !== null) {
      this.subdivision = this.pendingSubdivision;
      this.pendingSubdivision = null;
    }
    if (this.pendingAccents) {
      this.accents = this.pendingAccents;
      this.pendingAccents = null;
    }
    this.refreshBarParams();
  }

  private ensureNodes(): Promise<void> {
    if (
      this.ctx &&
      this.accentBuf &&
      this.beatBuf &&
      this.weakBuf &&
      this.softestBuf
    )
      return Promise.resolve();
    if (this.bufferInit) return this.bufferInit;
    this.bufferInit = (async () => {
      const ctx = getAudioEngine().getContext();
      const out = ctx.createGain();
      out.gain.value = this.volume * MAX_GAIN;
      out.connect(ctx.destination);
      // 4 버퍼 사전 렌더(병렬). Step 1 accent/beat 합성식 그대로(=비트 동일).
      const [accentBuf, beatBuf, weakBuf, softestBuf] = await Promise.all([
        renderClick(ctx.sampleRate, ACCENT_HZ, 1.0),
        renderClick(ctx.sampleRate, BEAT_HZ, 1.0),
        renderClick(ctx.sampleRate, WEAK_HZ, 0.6),
        renderClick(ctx.sampleRate, SOFTEST_HZ, 0.4),
      ]);
      this.ctx = ctx;
      this.out = out;
      this.accentBuf = accentBuf;
      this.beatBuf = beatBuf;
      this.weakBuf = weakBuf;
      this.softestBuf = softestBuf;
    })();
    return this.bufferInit;
  }

  private bufferForKind(kind: PulseKind): AudioBuffer | null {
    switch (kind) {
      case "strong":
        return this.accentBuf;
      case "mid":
        return this.beatBuf;
      case "weak":
        return this.weakBuf;
      case "softest":
        return this.softestBuf;
      case "mute":
        return null;
    }
  }

  private scheduleClickAt(time: number, kind: PulseKind): void {
    if (kind === "mute") return;
    const buf = this.bufferForKind(kind);
    if (!buf) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out!);
    src.start(time);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        /* 이미 끊김 — 무시 */
      }
    };
  }

  /**
   * Step 2 스케줄러 — Worker tick(또는 start 직후 즉시 1회) 시 호출.
   *
   * t 계산: tRaw = barStartTime + tickIdxInBar × currentSubInterval (주의 A, multiplicative).
   *        tRounded = round(tRaw × SR) / SR (정수 샘플 정책).
   * 바 경계: tickIdxInBar >= currentTicksPerBar →
   *   barStartTime += currentTicksPerBar × currentSubInterval (=현재 바 meter 길이, 주의 C)
   *   tickIdxInBar = 0; applyPendingSwap() (주의 B).
   * kind 결정: pulseKindAt(tickIdxInBar, meterPreset, subdivision, accents) — 순수 함수.
   */
  private scheduler = (): void => {
    if (
      !this.running ||
      !this.ctx ||
      !this.accentBuf ||
      !this.beatBuf ||
      !this.weakBuf ||
      !this.softestBuf
    )
      return;
    const ctx = this.ctx;
    const SR = ctx.sampleRate;
    while (true) {
      // 바 경계 — 옛 바 길이로 advance 후 pending swap (주의 B·C)
      if (this.tickIdxInBar >= this.currentTicksPerBar) {
        this.barStartTime += this.currentTicksPerBar * this.currentSubInterval;
        this.tickIdxInBar = 0;
        this.applyPendingSwap();
      }
      const tRaw =
        this.barStartTime + this.tickIdxInBar * this.currentSubInterval;
      const tRounded = Math.round(tRaw * SR) / SR;
      if (tRounded >= ctx.currentTime + SCHEDULE_AHEAD) break;
      const kind = pulseKindAt(
        this.tickIdxInBar,
        this.meterPreset,
        this.subdivision,
        this.accents,
      );
      this.scheduleClickAt(tRounded, kind);
      this.tickIdxInBar++;
    }
  };

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./metronome-worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<{ type: "tick" }>) => {
      if (e.data.type === "tick") this.scheduler();
    };
    this.worker = w;
    return w;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureNodes();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") await ctx.resume();
    this.running = true;
    this.barStartTime = ctx.currentTime + 0.05;
    this.tickIdxInBar = 0;
    this.refreshBarParams();
    this.ensureWorker().postMessage({
      type: "start",
      intervalMs: LOOKAHEAD_MS,
    });
    // 첫 tick(≤25ms 후)까지 지연을 피해 즉시 1회 실행 — Step 1 동일.
    this.scheduler();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker?.postMessage({ type: "stop" });
    // 이미 예약된(≤0.1s) 클릭은 그대로 끝남 — Step 1 동일.
  }

  /**
   * 표시 BPM 설정 (즉시 적용 — 라이브 회귀 보호).
   * subInterval 이 바뀌면 다음 tick 시각이 변하므로 barStartTime 을 시프트해
   * Step 1 의 nextNoteTime(=마지막 스케줄+oldInterval) 와 동일한 다음-tick 시각 보존.
   *   목표: barStartTime_new + tickIdxInBar × newSubInterval = barStartTime_old + tickIdxInBar × oldSubInterval
   *   ∴ barStartTime_new = barStartTime_old + tickIdxInBar × (oldSubInterval - newSubInterval)
   */
  setBpm(displayBpm: number): void {
    const v = Math.min(240, Math.max(40, Math.round(displayBpm)));
    this.displayBpm = v;
    const oldSubInterval = this.currentSubInterval;
    this.quarterBpm = displayBpmToQuarter(v, this.meterPreset.type);
    this.currentSubInterval =
      baseUnitDurSec(this.meterPreset.type, this.quarterBpm) / this.subdivision;
    if (this.running) {
      const shift =
        this.tickIdxInBar * (oldSubInterval - this.currentSubInterval);
      this.barStartTime += shift;
    }
  }

  /**
   * 박자 수 즉시 적용 (레거시 라이브 API). 내부적으로 simple-quarter 박자 변경.
   * Step 1 동작 보존: 다음 마디 대기 없이 즉시 다음 tick 부터 새 패턴.
   * subInterval 은 unchanged (simple-quarter, 같은 q, 같은 subdivision) →
   * barStartTime 시프트 불필요. 단 tickIdxInBar 가 새 tpb 보다 크면 바 경계가 자연 트리거.
   */
  setBeatsPerBar(n: number): void {
    const v = Math.min(7, Math.max(2, Math.round(n)));
    // 7/4 는 시각 스펙 12 프리셋 밖이라 PRESET_TABLE 미수록 — 동적 구성으로 어떤
    // v∈[2,7] 도 안전(silent fallback 회피, 옛 [2,7] API 시그니처 1:1 보존).
    const newPreset = makeSimpleQuarterPreset(v);
    this.meterPreset = newPreset;
    this.accents = defaultAccents(newPreset);
    // subdivision 유지. simple-quarter 라 q·subInterval 변화 없음.
    this.currentTicksPerBar = ticksPerBarOf(newPreset, this.subdivision);
  }

  setVolume(v01: number): void {
    this.volume = Math.min(1, Math.max(0, v01));
    if (this.out) this.out.gain.value = this.volume * MAX_GAIN;
    saveMetronomePrefs({ version: 1, volume: this.volume });
  }

  // ── 신규 API (Step 2, PracticeView 호출 0 = 휴면, 단위 테스트만) ──────────
  /** 박자 교체 — 다음 마디 경계 적용(주의 B). 표시 BPM 유지, q 재계산. */
  setMeter(presetKey: string): void {
    const preset = PRESET_TABLE[presetKey];
    if (!preset) return;
    this.pendingMeter = preset;
    // 새 박자에 맞는 기본 강세도 pending (사용자가 setAccents 로 즉시 덮어쓰면 그대로).
    if (this.pendingAccents === null) {
      this.pendingAccents = defaultAccents(preset);
    }
  }
  /** 세분화 — 다음 마디 경계 적용. */
  setSubdivision(s: number): void {
    this.pendingSubdivision = Math.max(1, Math.floor(s));
  }
  /** 강세 — 다음 마디 경계 적용. */
  setAccents(arr: readonly AccentLevel[]): void {
    this.pendingAccents = [...arr];
  }

  /**
   * 카운트인 — Step 1 시그니처 1:1 보존. 인자 bpm/beatsPerBar 그대로 사용.
   * 음색: 강박(1500Hz)·약박(900Hz) 만 — Step 1 동일(weak/softest 미사용).
   * sample-round 정수 샘플 정책 일관 적용.
   */
  playCountIn(opts: {
    bpm: number;
    beatsPerBar: number;
    bars: number;
    onDone: (songStartCtxTime: number) => void;
  }): { cancel: () => void } {
    const sources: AudioBufferSourceNode[] = [];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      await this.ensureNodes();
      if (cancelled) return;
      const ctx = this.ctx!;
      const SR = ctx.sampleRate;
      const P = 60 / Math.min(240, Math.max(40, opts.bpm));
      const beats =
        Math.max(1, opts.bars) *
        Math.min(7, Math.max(2, opts.beatsPerBar));
      const t0 = ctx.currentTime + 0.1;
      for (let i = 0; i < beats; i++) {
        const tRaw = t0 + i * P;
        const t = Math.round(tRaw * SR) / SR;
        const accent = i % opts.beatsPerBar === 0;
        const src = ctx.createBufferSource();
        src.buffer = accent ? this.accentBuf! : this.beatBuf!;
        src.connect(this.out!);
        src.start(t);
        src.onended = () => {
          try {
            src.disconnect();
          } catch {
            /* noop */
          }
        };
        sources.push(src);
      }
      const songStart = t0 + beats * P;
      const leadSec = Math.max(0, songStart - ctx.currentTime - 0.05);
      timer = setTimeout(() => {
        if (cancelled) return;
        opts.onDone(songStart);
      }, leadSec * 1000);
    })();
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (timer != null) clearTimeout(timer);
        if (this.ctx) {
          const now = this.ctx.currentTime;
          for (const s of sources) {
            try {
              s.stop(now);
            } catch {
              /* 이미 끝남 — 무시 */
            }
          }
        }
      },
    };
  }

  isRunning(): boolean {
    return this.running;
  }
  getState(): {
    running: boolean;
    bpm: number;
    beatsPerBar: number;
    volume: number;
  } {
    return {
      running: this.running,
      bpm: this.displayBpm,
      // 라이브는 simple-quarter 만 사용 → numerator = 사용자 인지 박자 수.
      beatsPerBar: this.meterPreset.numerator,
      volume: this.volume,
    };
  }
}

let singleton: MetronomeEngine | null = null;

/** 앱 전체 단일 메트로놈 — Step 1 의 getMetronome 시그니처 호환. */
export function getMetronome(): MetronomeEngine {
  if (!singleton) singleton = new MetronomeEngine();
  return singleton;
}

export { MetronomeEngine };
