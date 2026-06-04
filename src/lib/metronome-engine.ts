// 헤드리스 메트로놈 엔진 — 2차-9 Step 1.
//
// v2 lock 적용:
// - L1 독립 본체. 상태 소유 = 자기 필드 + metronome-prefs(전역 단일 버전드 객체).
//   Step 1 prefs 영속 범위 = volume 만. tempo/beats 는 호출자(PracticeView)가
//   곡 mirror 로 setBpm/setBeatsPerBar 호출(§5 무중단 마이그레이션 경로).
// - L2 tempo 내부 표준 = 4분음표 BPM. Step 1 시점 meter 4/4 고정 → 표시=내부
//   (변환 0). Step 2 에서 분모/복합 도입 시 setBpm 입력의 beatUnit→quarter 변환
//   이 추가될 자리(현재는 1:1 패스스루).
// - L4 단순 박자 처리(2-7). 강박/약박 2단계. 그룹/세분화/다단계 강세는 Step 2.
// - L6 N95 방어: lookahead 타이머는 metronome-worker, 메인은 노드 예약만.
//   클릭음은 OfflineAudioContext 로 기존 osc 합성을 사전 렌더한 AudioBuffer.
//   박마다 AudioBufferSourceNode 만 새로 만들어 그 버퍼를 가리킴 → 매 클릭마다
//   Oscillator+Gain 노드 2개 신규 생성하던 GC 부담 제거(버퍼 자체는 영속 1개씩).
//
// 기존 metronome.ts 와의 외부 호환: getMetronome() 시그니처/메서드 명·인자 1:1,
// playCountIn 시그니처 1:1 (호출자 PracticeView 무변경).
import { getAudioEngine } from "./audio-engine";
import {
  loadMetronomePrefs,
  saveMetronomePrefs,
} from "./metronome-prefs";

const LOOKAHEAD_MS = 25; // 스케줄러 점검 주기 (worker setInterval)
const SCHEDULE_AHEAD = 0.1; // 이 시간(초) 안에 올 박을 미리 예약
const ACCENT_HZ = 1500; // 강박(마디 첫 박)
const BEAT_HZ = 900; // 약박
const MAX_GAIN = 0.9; // 볼륨 100% 매핑(클리핑 회피)

// 클릭음 합성 파라미터 — 기존 metronome.ts 의 scheduleClick 와 비트 동일.
// 변경 시 OfflineAudioContext 렌더 결과가 달라져 회귀 발생 — 손대지 말 것.
const CLICK_DURATION = 0.05; // osc.start(t); osc.stop(t+0.05)
const ATTACK = 0.001; // linearRamp 1ms 어택
const RELEASE = 0.04; // exponentialRamp 40ms 감쇠 종점

/**
 * 기존 osc 클릭과 음색 비트 동일한 AudioBuffer 를 OfflineAudioContext 로 렌더.
 * 같은 triangle osc + 같은 gain envelope. 임의 샘플 없음.
 * @param sampleRate 라이브 AudioContext 와 동일 SR(미일치 시 피치 변동)
 * @param accent true → ACCENT_HZ(1500), false → BEAT_HZ(900)
 */
async function renderClick(
  sampleRate: number,
  accent: boolean,
): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(CLICK_DURATION * sampleRate));
  const offline = new OfflineAudioContext(1, len, sampleRate);
  const osc = offline.createOscillator();
  const g = offline.createGain();
  osc.type = "triangle";
  osc.frequency.value = accent ? ACCENT_HZ : BEAT_HZ;
  // 기존 scheduleClick 의 envelope 와 동일 (offline 기준 t=0 으로 평행이동)
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, ATTACK);
  g.gain.exponentialRampToValueAtTime(0.0001, RELEASE);
  osc.connect(g);
  g.connect(offline.destination);
  osc.start(0);
  osc.stop(CLICK_DURATION);
  return offline.startRendering();
}

class MetronomeEngine {
  // 오디오 노드 (lazy init — getAudioEngine 컨텍스트가 준비된 시점에)
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private accentBuf: AudioBuffer | null = null;
  private beatBuf: AudioBuffer | null = null;
  private bufferInit: Promise<void> | null = null; // ensureNodes 중복 호출 가드

  // 사용자 보이는 상태
  private running = false;
  private quarterBpm = 120; // 내부 4분음표 BPM (Step 1: meter 4/4 → display=quarter)
  private beatsPerBar = 4;
  private volume = 0.7;

  // 스케줄러 상태
  private worker: Worker | null = null;
  private nextNoteTime = 0;
  private beatInBar = 0;

  constructor() {
    // 영속 prefs 로드 — Step 1 범위 = volume 만
    const prefs = loadMetronomePrefs();
    this.volume = prefs.volume;
  }

  /** AudioContext/GainNode/클릭 버퍼 lazy init. 멀티 호출 안전(같은 Promise 반환). */
  private ensureNodes(): Promise<void> {
    if (this.ctx && this.accentBuf && this.beatBuf) return Promise.resolve();
    if (this.bufferInit) return this.bufferInit;
    this.bufferInit = (async () => {
      const ctx = getAudioEngine().getContext();
      const out = ctx.createGain();
      out.gain.value = this.volume * MAX_GAIN;
      out.connect(ctx.destination);
      const [accentBuf, beatBuf] = await Promise.all([
        renderClick(ctx.sampleRate, true),
        renderClick(ctx.sampleRate, false),
      ]);
      this.ctx = ctx;
      this.out = out;
      this.accentBuf = accentBuf;
      this.beatBuf = beatBuf;
    })();
    return this.bufferInit;
  }

  /** 메인 스레드 스케줄러 — worker tick 받아 호출 (또는 start() 첫 호출 즉시). */
  private scheduler = (): void => {
    if (!this.running || !this.ctx || !this.accentBuf || !this.beatBuf) return;
    const ctx = this.ctx;
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      this.scheduleClick(this.nextNoteTime, this.beatInBar === 0);
      this.nextNoteTime += 60 / this.quarterBpm;
      this.beatInBar = (this.beatInBar + 1) % this.beatsPerBar;
    }
  };

  /**
   * 한 박 클릭을 정확한 시각에 예약.
   * AudioBufferSourceNode 1개 생성(노드 자체 재사용 불가 — 한번 start 후 폐기),
   * 가리키는 AudioBuffer 는 풀(accentBuf/beatBuf) → 무거운 osc/gain 신규 생성 회피.
   */
  private scheduleClick(time: number, accent: boolean): void {
    const ctx = this.ctx!;
    const buf = accent ? this.accentBuf! : this.beatBuf!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out!);
    src.start(time);
    // 끝나면 즉시 disconnect — GC 회수 빠르게
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        /* 이미 끊김 — 무시 */
      }
    };
  }

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
    this.beatInBar = 0;
    this.nextNoteTime = ctx.currentTime + 0.05;
    this.ensureWorker().postMessage({
      type: "start",
      intervalMs: LOOKAHEAD_MS,
    });
    // 첫 tick 까지 ≤25ms 지연이 있을 수 있어 즉시 한 번 실행 → 첫 클릭(+0.05s)이
    // SCHEDULE_AHEAD 창 안에 확실히 들어가게 한다(=현 metronome.ts 와 동일 첫 박 동작).
    this.scheduler();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker?.postMessage({ type: "stop" });
    // 이미 예약된(≤0.1s) 클릭은 그대로 끝남 — 무해(기존 동작과 동일).
  }

  /**
   * 메트로놈이 사용하는 BPM(표시값). Step 1 시점 meter 4/4 고정 → 표시 == 4분 BPM
   * (변환 0). Step 2 에서 분모/복합 도입 시 이 메서드 입력의 beatUnit → quarter
   * 변환이 추가될 단일 지점.
   */
  setBpm(displayBpm: number): void {
    this.quarterBpm = Math.min(240, Math.max(40, Math.round(displayBpm)));
  }
  setBeatsPerBar(n: number): void {
    this.beatsPerBar = Math.min(7, Math.max(2, Math.round(n)));
  }
  setVolume(v01: number): void {
    this.volume = Math.min(1, Math.max(0, v01));
    if (this.out) this.out.gain.value = this.volume * MAX_GAIN;
    // 영속 prefs 즉시 저장(Step 1 범위 = volume).
    saveMetronomePrefs({ version: 1, volume: this.volume });
  }

  /**
   * 카운트인 — 본체 start/stop 과 독립 트리거. 시그니처 = 기존 metronome.ts 그대로
   * (PracticeView 호출 무영향). 곡 정렬은 곡 쪽 책임 — 이 메서드는 클릭만 예약.
   *
   * ensureNodes 가 async 라 첫 호출 race 가능성: cancel 반환은 동기, 실제 예약은
   * ensureNodes 완료 후 진행. 호출자(PracticeView)는 cancel 핸들만 즉시 잡고
   * onDone 은 예약된 곡 시작 시각에 발화 — 첫 호출이 ensureNodes(<1ms) 대기로
   * 살짝 늦어도 onDone 의 songStart 시각이 ctx.currentTime 기반으로 계산되어
   * 정렬 정확성은 유지.
   *
   * @returns cancel(): 미발화 클릭 stop + onDone 발화 차단.
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
      const P = 60 / Math.min(240, Math.max(40, opts.bpm));
      const beats =
        Math.max(1, opts.bars) *
        Math.min(7, Math.max(2, opts.beatsPerBar));
      const t0 = ctx.currentTime + 0.1; // 첫 클릭 살짝 미래에서 시작(스케줄 여유)
      for (let i = 0; i < beats; i++) {
        const t = t0 + i * P;
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
      const songStart = t0 + beats * P; // 마지막 박의 다음 박 = 곡 1박
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
              s.stop(now); // 아직 안 울린 클릭 무력화(이미 끝난 건 무시)
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
      bpm: this.quarterBpm, // Step 1: meter 4/4 → display == quarter
      beatsPerBar: this.beatsPerBar,
      volume: this.volume,
    };
  }
}

let singleton: MetronomeEngine | null = null;

/** 앱 전체 단일 메트로놈 — 기존 metronome.ts 의 getMetronome 시그니처 호환. */
export function getMetronome(): MetronomeEngine {
  if (!singleton) singleton = new MetronomeEngine();
  return singleton;
}

export { MetronomeEngine };
