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

  /** 한 박 클릭을 정확한 시각에 예약(일회용 osc+gain, 끝나면 정리). */
  private scheduleClick(time: number, accent: boolean): void {
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
