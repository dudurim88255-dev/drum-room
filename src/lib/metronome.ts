// 메트로놈 — 곡 재생 엔진과 분리된 독립 모듈.
// AudioContext 는 audio-engine 의 단일 컨텍스트를 공유(같은 clock)하되,
// 자기 GainNode → destination 으로만 출력한다(곡 게인 체인 무관·무영향).
// 정밀 타이밍: lookahead 스케줄러(타이머는 "언제 예약할지"만, 소리 시각은
// Web Audio 가 샘플 정확) — 검증된 메트로놈 패턴.
import { getAudioEngine } from "./audio-engine";

const LOOKAHEAD_MS = 25; // 스케줄러 점검 주기
const SCHEDULE_AHEAD = 0.1; // 이 시간(초) 안에 올 박을 미리 예약
const ACCENT_HZ = 1500; // 강박(마디 첫 박)
const BEAT_HZ = 900; // 약박
const MAX_GAIN = 0.9; // 볼륨 100% 매핑(클리핑 회피)

class Metronome {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;

  private running = false;
  private bpm = 120;
  private beatsPerBar = 4;
  private volume = 0.7; // 0..1 (UI 0~100% → /100)

  private timer: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private beatInBar = 0;

  /** 공유 컨텍스트 + 전용 출력 게인 확보(최초 1회). 곡 체인과 분리. */
  private ensureNodes(): void {
    if (this.ctx) return;
    const ctx = getAudioEngine().getContext(); // 단일 컨텍스트 공유
    const out = ctx.createGain();
    out.gain.value = this.volume * MAX_GAIN;
    out.connect(ctx.destination); // 곡 master/drum/backing 과 무관
    this.ctx = ctx;
    this.out = out;
  }

  /** 한 박 클릭을 정확한 시각에 예약(일회용 osc+gain, 끝나면 정리).
   * @returns 생성된 OscillatorNode (카운트인 취소 시 미발화분 stop 용도). */
  private scheduleClick(time: number, accent: boolean): OscillatorNode {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = accent ? ACCENT_HZ : BEAT_HZ;
    // 팝 노이즈 방지: 짧은 어택 → exp 감쇠. 레벨은 out 게인이 관장.
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(1, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    osc.connect(g);
    g.connect(this.out!);
    osc.start(time);
    osc.stop(time + 0.05);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
    return osc;
  }

  /** [now, now+SCHEDULE_AHEAD] 안의 박을 모두 예약하고 다음 박 계산. */
  private scheduler = (): void => {
    const ctx = this.ctx!;
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      this.scheduleClick(this.nextNoteTime, this.beatInBar === 0);
      this.nextNoteTime += 60 / this.bpm; // BPM 변경은 다음 박부터 즉시 반영
      this.beatInBar = (this.beatInBar + 1) % this.beatsPerBar;
    }
  };

  async start(): Promise<void> {
    if (this.running) return;
    this.ensureNodes();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") await ctx.resume();
    this.running = true;
    this.beatInBar = 0;
    this.nextNoteTime = ctx.currentTime + 0.05;
    this.timer = setInterval(this.scheduler, LOOKAHEAD_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    // 이미 예약된(≤0.1s) 클릭은 그대로 끝남 — 무해.
  }

  setBpm(n: number): void {
    this.bpm = Math.min(240, Math.max(40, Math.round(n)));
  }
  setBeatsPerBar(n: number): void {
    this.beatsPerBar = Math.min(7, Math.max(2, Math.round(n)));
  }
  setVolume(v01: number): void {
    this.volume = Math.min(1, Math.max(0, v01));
    if (this.out) this.out.gain.value = this.volume * MAX_GAIN;
  }

  /**
   * 카운트인: N마디(=bars*beatsPerBar 박) 클릭을 미리 예약하고, 마지막 박
   * 다음 박 시각(=곡 첫 박이 되어야 하는 ctx 시각)을 onDone 으로 통지.
   * onDone 콜백은 그 시각보다 약간 앞당겨 호출되므로 caller 가
   * audio-engine.playAt(songStartCtx, offset) 로 Web Audio 정밀 예약 가능.
   * 메트로놈 사용자 on/off(start/stop) 와 별개 트리거 — 그것에 영향 없음.
   *
   * @returns cancel(): 미발화 클릭 stop + onDone 발화 차단.
   */
  playCountIn(opts: {
    bpm: number;
    beatsPerBar: number;
    bars: number;
    onDone: (songStartCtxTime: number) => void;
  }): { cancel: () => void } {
    this.ensureNodes();
    const ctx = this.ctx!;
    const P = 60 / Math.min(240, Math.max(40, opts.bpm));
    const beats = Math.max(1, opts.bars) * Math.min(7, Math.max(2, opts.beatsPerBar));
    const t0 = ctx.currentTime + 0.1; // 첫 클릭 살짝 미래에서 시작(스케줄 여유)
    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < beats; i++) {
      const t = t0 + i * P;
      const accent = i % opts.beatsPerBar === 0;
      oscs.push(this.scheduleClick(t, accent));
    }
    const songStart = t0 + beats * P; // 마지막 박의 다음 박 = 곡 1박
    let cancelled = false;
    // 곡 시작 50ms 전에 콜백 → caller 가 playAt 으로 정확 예약(WA 정밀)
    const leadSec = Math.max(0, songStart - ctx.currentTime - 0.05);
    const timer = setTimeout(() => {
      if (cancelled) return;
      opts.onDone(songStart);
    }, leadSec * 1000);
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(timer);
        const now = ctx.currentTime;
        for (const o of oscs) {
          try {
            o.stop(now); // 아직 안 울린 osc 무력화(이미 끝난 건 무시됨)
          } catch {
            /* 이미 끝남 — 무시 */
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
      bpm: this.bpm,
      beatsPerBar: this.beatsPerBar,
      volume: this.volume,
    };
  }
}

let singleton: Metronome | null = null;

/** 앱 전체 단일 메트로놈(곡 엔진과 컨텍스트 공유, 출력은 분리). */
export function getMetronome(): Metronome {
  if (!singleton) singleton = new Metronome();
  return singleton;
}

export { Metronome };
