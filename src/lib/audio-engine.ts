// drum-room 재생 엔진 (1차의 핵심).
// 두 AudioBuffer(드럼/반주)를 Web Audio로 동시 재생하고, 드럼 트랙 게인만 조절한다.
// 4단계에서 입력 소스(test-audio → 실제 분리 결과)만 바뀌도록 에셋 비의존 설계.
//
// 그래프:
//   drumsSource   → drumGain   ─┐
//                                ├→ masterGain → destination
//   backingSource → backingGain ┘

type DebugState = {
  hasContext: boolean;
  contextState: AudioContextState | "none";
  contextCreations: number; // 앱 전체에서 1이어야 한다
  nodes: { master: boolean; drum: boolean; backing: boolean };
  loaded: boolean;
  playing: boolean;
  drumGainValue: number;
  backingGainValue: number;
  targetDrumVolume: number;
  lastStartArgs: { drums: number | null; backing: number | null };
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private drumGain: GainNode | null = null;
  private backingGain: GainNode | null = null;

  private drumsBuffer: AudioBuffer | null = null;
  private backingBuffer: AudioBuffer | null = null;

  private drumsSource: AudioBufferSourceNode | null = null;
  private backingSource: AudioBufferSourceNode | null = null;

  private playing = false;
  private manualStop = false;
  private endedCb: (() => void) | null = null;

  // 검증/디버그용
  private contextCreations = 0;
  private lastStartArgs: { drums: number | null; backing: number | null } = {
    drums: null,
    backing: null,
  };
  // 컨텍스트 생성 전 setDrumVolume 호출돼도 값 보존
  private targetDrumVolume = 0.25;

  // load 중복 방지 (React StrictMode 이중 마운트 대비)
  private loadKey: string | null = null;
  private loadPromise: Promise<void> | null = null;

  /** AudioContext·게인 노드는 한 번만 만든다 (앱 전체 단일 컨텍스트). */
  private ensureContext(): void {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctor();
    this.contextCreations += 1;

    this.masterGain = this.ctx.createGain();
    this.drumGain = this.ctx.createGain();
    this.backingGain = this.ctx.createGain();

    this.masterGain.gain.value = 1; // 1차 고정
    this.backingGain.gain.value = 1; // 반주는 항상 100%
    this.drumGain.gain.value = this.targetDrumVolume;

    this.drumGain.connect(this.masterGain);
    this.backingGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  /** 두 트랙을 fetch→decode. 같은 키면 재호출해도 한 번만 (idempotent). */
  load(drumsUrl: string, backingUrl: string): Promise<void> {
    const key = `${drumsUrl}|${backingUrl}`;
    if (this.loadKey === key && this.loadPromise) return this.loadPromise;

    this.loadKey = key;
    this.loadPromise = (async () => {
      this.ensureContext();
      const ctx = this.ctx!;
      const [dBuf, bBuf] = await Promise.all([
        fetch(drumsUrl).then((r) => {
          if (!r.ok) throw new Error(`drums fetch ${r.status}`);
          return r.arrayBuffer();
        }),
        fetch(backingUrl).then((r) => {
          if (!r.ok) throw new Error(`backing fetch ${r.status}`);
          return r.arrayBuffer();
        }),
      ]);
      // decodeAudioData는 입력 ArrayBuffer를 detach할 수 있어 각자 받음
      const [drums, backing] = await Promise.all([
        ctx.decodeAudioData(dBuf),
        ctx.decodeAudioData(bBuf),
      ]);
      this.drumsBuffer = drums;
      this.backingBuffer = backing;
    })();

    // 실패 시 다음 호출에서 재시도 가능하도록 캐시 무효화
    this.loadPromise.catch(() => {
      this.loadKey = null;
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  isLoaded(): boolean {
    return !!(this.drumsBuffer && this.backingBuffer);
  }

  /** 두 트랙을 같은 시각 인자로 동시 시작 (싱크 핵심). */
  async play(): Promise<void> {
    this.ensureContext();
    if (!this.isLoaded() || this.playing) return;

    const ctx = this.ctx!;
    // 브라우저 자동재생 정책: 사용자 제스처(재생 버튼) 후 resume 필요
    if (ctx.state === "suspended") await ctx.resume();

    const drumsSource = ctx.createBufferSource();
    const backingSource = ctx.createBufferSource();
    drumsSource.buffer = this.drumsBuffer;
    backingSource.buffer = this.backingBuffer;
    drumsSource.connect(this.drumGain!);
    backingSource.connect(this.backingGain!);

    this.manualStop = false;
    // 자연 종료 감지는 드럼(스펙상 두 트랙 동일 길이)을 클럭으로 사용.
    // onended는 stop()에서도 발화하므로 manualStop으로 구분.
    drumsSource.onended = () => {
      if (this.manualStop) return;
      this.cleanupSources();
      this.playing = false;
      this.endedCb?.();
    };

    // 같은 한 시점을 정해 두 소스 모두 그 인자로 start (절대 인자 없이 따로 호출 안 함)
    const startAt = ctx.currentTime + 0.1;
    drumsSource.start(startAt);
    backingSource.start(startAt);

    this.drumsSource = drumsSource;
    this.backingSource = backingSource;
    this.lastStartArgs = { drums: startAt, backing: startAt };
    this.playing = true;
  }

  /** 정지. 소스 노드는 일회용이라 버리고, 다음 재생 때 새로 만든다. */
  stop(): void {
    if (!this.playing) return;
    this.manualStop = true;
    try {
      this.drumsSource?.stop();
    } catch {
      /* 이미 멈춘 경우 무시 */
    }
    try {
      this.backingSource?.stop();
    } catch {
      /* 이미 멈춘 경우 무시 */
    }
    this.cleanupSources();
    this.playing = false;
  }

  private cleanupSources(): void {
    this.drumsSource?.disconnect();
    this.backingSource?.disconnect();
    this.drumsSource = null;
    this.backingSource = null;
  }

  /** 드럼 볼륨 0.0~1.0. 급격한 점프의 "틱" 잡음 방지를 위해 짧게 부드럽게. */
  setDrumVolume(v01: number): void {
    const v = Math.min(1, Math.max(0, v01));
    this.targetDrumVolume = v;
    if (this.ctx && this.drumGain) {
      this.drumGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.008);
    }
  }

  setOnEnded(cb: (() => void) | null): void {
    this.endedCb = cb;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getDebugState(): DebugState {
    return {
      hasContext: !!this.ctx,
      contextState: this.ctx ? this.ctx.state : "none",
      contextCreations: this.contextCreations,
      nodes: {
        master: !!this.masterGain,
        drum: !!this.drumGain,
        backing: !!this.backingGain,
      },
      loaded: this.isLoaded(),
      playing: this.playing,
      drumGainValue: this.drumGain ? this.drumGain.gain.value : -1,
      backingGainValue: this.backingGain ? this.backingGain.gain.value : -1,
      targetDrumVolume: this.targetDrumVolume,
      lastStartArgs: this.lastStartArgs,
    };
  }
}

let singleton: AudioEngine | null = null;

/** 앱 전체에서 단일 인스턴스(=단일 AudioContext). */
export function getAudioEngine(): AudioEngine {
  if (!singleton) singleton = new AudioEngine();
  return singleton;
}

export type { DebugState };
export { AudioEngine };
