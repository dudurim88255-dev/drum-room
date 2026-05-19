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
  position: number;
  duration: number;
  loop: { enabled: boolean; a: number; b: number };
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
  private endedCb: (() => void) | null = null;

  // 검증/디버그용
  private contextCreations = 0;
  private lastStartArgs: { drums: number | null; backing: number | null } = {
    drums: null,
    backing: null,
  };
  // 컨텍스트 생성 전 setDrumVolume 호출돼도 값 보존
  private targetDrumVolume = 0.25;

  // 2차-3: 타임라인/seek/구간반복. 플레이헤드(정지 시 보존·재개 시작점),
  // 마지막 start 의 ctx 시각·offset(위치 계산용), 구간 반복(A~B).
  private playhead = 0;
  private startCtxTime = 0;
  private startOffset = 0;
  private loopEnabled = false;
  private loopA = 0;
  private loopB = 0;

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
    // 분리 출력 버퍼는 44100Hz. 디바이스 기본 컨텍스트(보통 48000)로 재생하면
    // Web Audio 가 리샘플 → ~8.8% 피치/템포 어긋남 + 트랜지언트(드럼 어택)
    // 뭉개짐. 컨텍스트를 44100 으로 만들어 네이티브 재생(리샘플 제거).
    try {
      this.ctx = new Ctor({ sampleRate: 44100 });
    } catch {
      this.ctx = new Ctor();
    }
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

  /** 분리 엔진이 만든 두 AudioBuffer 를 직접 주입 (4-C: fetch/decode 불필요). */
  loadBuffers(drums: AudioBuffer, backing: AudioBuffer): void {
    this.ensureContext();
    if (this.playing) this.stop();
    this.drumsBuffer = drums;
    this.backingBuffer = backing;
    this.loadKey = "buffers";
    this.loadPromise = Promise.resolve();
    // 새 곡 → 위치·구간 반복 초기화(이전 곡 상태가 새 곡에 새지 않게)
    this.playhead = 0;
    this.loopEnabled = false;
    this.loopA = 0;
    this.loopB = 0;
  }

  /** 분리 결과 AudioBuffer 를 같은 컨텍스트에서 만들도록 컨텍스트 공유 (단일 AudioContext 유지). */
  getContext(): AudioContext {
    this.ensureContext();
    return this.ctx!;
  }

  isLoaded(): boolean {
    return !!(this.drumsBuffer && this.backingBuffer);
  }

  private hasValidLoop(): boolean {
    const dur = this.getDuration();
    return (
      this.loopEnabled &&
      this.loopB - this.loopA > 0.02 &&
      this.loopA >= 0 &&
      this.loopB <= dur + 1e-6
    );
  }

  /**
   * 두 트랙을 같은 시각·같은 offset 으로 동시 start (싱크 핵심).
   * 구간 반복이 켜져 있으면 두 소스에 동일 loopStart/End 설정 →
   * 네이티브 샘플 정확 반복(JS 타이머 없음, A↔B 끊김·드리프트 없음).
   */
  private startSources(offset: number): void {
    const ctx = this.ctx!;
    const drumsSource = ctx.createBufferSource();
    const backingSource = ctx.createBufferSource();
    drumsSource.buffer = this.drumsBuffer;
    backingSource.buffer = this.backingBuffer;
    drumsSource.connect(this.drumGain!);
    backingSource.connect(this.backingGain!);

    if (this.hasValidLoop()) {
      for (const s of [drumsSource, backingSource]) {
        s.loop = true;
        s.loopStart = this.loopA;
        s.loopEnd = this.loopB;
      }
    }

    // 자연 종료 감지는 드럼을 클럭으로(두 트랙 동일 길이). 구간 반복 중에는
    // loop=true 라 onended 가 발화하지 않는다(사용자가 끄거나 정지할 때까지).
    // ⚠ seek/stop 으로 교체된 옛 소스의 늦은 onended 는 무시 — 현재 활성
    // 소스의 자연 종료만 "곡 끝" 처리(stale-callback 경쟁 차단). 플래그
    // 타이밍에 의존하면 startSources 가 플래그를 되돌려 새 재생을 죽인다.
    const activeDrums = drumsSource;
    drumsSource.onended = () => {
      if (this.drumsSource !== activeDrums) return; // 폐기된 소스 — 무시
      this.cleanupSources();
      this.playing = false;
      this.playhead = 0; // 곡 끝 = 처음으로 되감되 정지(멋대로 반복 안 함)
      this.endedCb?.();
    };

    const startAt = ctx.currentTime + 0.1;
    drumsSource.start(startAt, offset);
    backingSource.start(startAt, offset);

    this.drumsSource = drumsSource;
    this.backingSource = backingSource;
    this.startCtxTime = startAt;
    this.startOffset = offset;
    this.lastStartArgs = { drums: startAt, backing: startAt };
  }

  /** 플레이헤드(또는 구간 A)에서 두 트랙 동시 재생 시작. */
  async play(): Promise<void> {
    this.ensureContext();
    if (!this.isLoaded() || this.playing) return;

    const ctx = this.ctx!;
    // 브라우저 자동재생 정책: 사용자 제스처(재생 버튼) 후 resume 필요
    if (ctx.state === "suspended") await ctx.resume();

    let offset = Math.min(Math.max(this.playhead, 0), this.getDuration());
    if (this.hasValidLoop() && (offset < this.loopA || offset >= this.loopB)) {
      offset = this.loopA; // 구간 반복이면 구간 안에서 시작
    }
    this.startSources(offset);
    this.playing = true;
  }

  /** 정지. 위치를 보존(다음 재생에서 이어 시작). 소스는 일회용이라 버린다. */
  stop(): void {
    if (!this.playing) return;
    this.playhead = this.getPosition(); // 보존 (teardown 전에 계산)
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

  /** 곡 전체 길이(초). */
  getDuration(): number {
    return this.drumsBuffer ? this.drumsBuffer.duration : 0;
  }

  /** 현재 재생 위치(초). 정지 시 플레이헤드, 재생 시 ctx 시각 기반. */
  getPosition(): number {
    const dur = this.getDuration();
    if (!this.playing || !this.ctx) {
      return Math.min(Math.max(this.playhead, 0), dur);
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
    if (
      this.hasValidLoop() &&
      this.startOffset >= this.loopA &&
      this.startOffset < this.loopB
    ) {
      const len = this.loopB - this.loopA;
      return this.loopA + ((this.startOffset - this.loopA + elapsed) % len);
    }
    return Math.min(this.startOffset + elapsed, dur);
  }

  /** 특정 위치로 이동. 두 소스를 같은 offset 으로 재시작(싱크 유지). */
  seek(t: number): void {
    this.ensureContext();
    const dur = this.getDuration();
    if (dur <= 0) return;
    const pos = this.hasValidLoop()
      ? Math.min(Math.max(t, this.loopA), Math.max(this.loopA, this.loopB - 0.001))
      : Math.min(Math.max(t, 0), dur);
    this.playhead = pos;
    if (this.playing) {
      // 옛 소스 정지 → cleanup → 새 offset 으로 재시작. 옛 소스의 늦은
      // onended 는 위 동일성 가드가 무시(this.drumsSource 가 교체됨).
      try {
        this.drumsSource?.stop();
      } catch {
        /* 무시 */
      }
      try {
        this.backingSource?.stop();
      } catch {
        /* 무시 */
      }
      this.cleanupSources();
      this.startSources(pos); // 새 활성 소스 → 옛 소스 onended 는 무효
    }
  }

  /**
   * 구간 반복 A~B(초) 설정. 스왑 없음(호출부가 A<B 보장, 역전 입력은
   * hasValidLoop=false 로 무시). 재생·반복 중일 때 현재 위치가 새 구간
   * 안이면 소스 재생성 없이 라이브 loopStart/loopEnd 만 갱신(이음매 없음)
   * + 위치 회계 rebase(타임라인 정확 유지), 밖일 때만 1회 seek.
   */
  setLoopRegion(a: number, b: number): void {
    const dur = this.getDuration();
    const A = Math.min(Math.max(a, 0), dur);
    const B = Math.min(Math.max(b, 0), dur);
    // 변경 전(옛 구간 기준) 현재 가청 위치를 먼저 구한다 — loopA/B 를
    // 덮어쓰면 getPosition 의 루프 계산 기준이 바뀌어 부정확해진다.
    const pBefore = this.getPosition();
    this.loopA = A;
    this.loopB = B;
    if (!(this.playing && this.hasValidLoop())) return;
    if (pBefore >= A && pBefore < B) {
      for (const s of [this.drumsSource, this.backingSource]) {
        if (s) {
          s.loop = true;
          s.loopStart = A;
          s.loopEnd = B;
        }
      }
      this.startOffset = pBefore; // 새 구간 기준으로 위치 회계 재기준
      this.startCtxTime = this.ctx!.currentTime;
    } else {
      this.seek(A); // 구간 밖일 때만 점프(한 번)
    }
  }

  /** 구간 반복 켜기/끄기. 재생 중에도 끊김 없이 반영. */
  setLoopEnabled(on: boolean): void {
    this.loopEnabled = on;
    if (!this.playing) return;
    if (on && this.hasValidLoop()) {
      const p = this.getPosition();
      if (p < this.loopA || p >= this.loopB) {
        this.seek(this.loopA);
      } else {
        for (const s of [this.drumsSource, this.backingSource]) {
          if (s) {
            s.loop = true;
            s.loopStart = this.loopA;
            s.loopEnd = this.loopB;
          }
        }
      }
    } else {
      // 끄기: 라이브로 loop 해제 → 자연 종료까지 재생 후 정지(반복 안 함)
      for (const s of [this.drumsSource, this.backingSource]) {
        if (s) s.loop = false;
      }
    }
  }

  getLoop(): { enabled: boolean; a: number; b: number } {
    return { enabled: this.loopEnabled, a: this.loopA, b: this.loopB };
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
      position: this.getPosition(),
      duration: this.getDuration(),
      loop: this.getLoop(),
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
