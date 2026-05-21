// BPM 분석 파사드(싱글턴) — SeparatingView 가 호출, PracticeView 가 구독.
// 캐시 우선(result-cache 메타에 BPM 있으면 즉시 ready) → 없으면 worker 가동.
// 사용자 보정(BPM/박자/다운비트)도 여기를 통해 캐시 영구 저장한다.

import { getSongMeta, updateSongMeta } from "./result-cache";

export type BpmStatus = "idle" | "pending" | "ready" | "failed";
export type BpmState = {
  hash: string | null;
  status: BpmStatus;
  bpm: number; // 사용 값(사용자 보정 반영)
  bpmDetected: number | null; // 자동 감지 원본(불변)
  beatsPerBar: number;
  downbeatOffsetSec: number;
  userTouched: boolean; // true 면 자동 결과로 bpm 덮어쓰기 금지
};

const DEFAULT: BpmState = {
  hash: null,
  status: "idle",
  bpm: 120,
  bpmDetected: null,
  beatsPerBar: 4,
  downbeatOffsetSec: 0,
  userTouched: false,
};

type AudioIn = {
  drumsL: Float32Array;
  drumsR: Float32Array;
  sampleRate: number;
};

class BpmAnalyzer {
  private state: BpmState = { ...DEFAULT };
  private subs = new Set<(s: BpmState) => void>();
  private worker: Worker | null = null;

  getState(): BpmState {
    return { ...this.state };
  }
  subscribe(cb: (s: BpmState) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  private emit(): void {
    const snap = this.getState();
    for (const cb of this.subs) cb(snap);
  }

  /**
   * SeparatingView 가 분리/복원 완료 직후 호출. 같은 곡(hash) 재호출은 무시.
   * 캐시 메타에 BPM 있으면 즉시 ready, 없으면 worker 로 분석(비차단).
   */
  async setCurrentSong(hash: string, audio: AudioIn): Promise<void> {
    if (this.state.hash === hash && this.state.status !== "idle") return;
    // 새 곡 → 상태 리셋(이전 곡 사용자 보정/분석 영향 차단)
    this.cancelWorker();
    this.state = { ...DEFAULT, hash };
    this.emit();

    const meta = await getSongMeta(hash);
    if (meta) {
      this.state.bpm = meta.bpm ?? 120;
      this.state.bpmDetected = meta.bpmDetected ?? null;
      this.state.beatsPerBar = meta.beatsPerBar ?? 4;
      this.state.downbeatOffsetSec = meta.downbeatOffsetSec ?? 0;
    }
    if (meta?.bpmDetected != null) {
      this.state.status = "ready";
      this.emit();
      return; // 캐시 히트 — 분석 재실행 안 함
    }

    this.state.status = "pending";
    this.emit();
    try {
      const bpm = await this.runWorker(audio);
      // 메모: 분석 중에 사용자가 BPM 등을 직접 만졌으면 자동값으로 덮지 않음.
      this.state.bpmDetected = bpm;
      if (!this.state.userTouched) this.state.bpm = bpm;
      this.state.status = "ready";
      void updateSongMeta(hash, {
        bpmDetected: bpm,
        bpm: this.state.bpm,
        beatsPerBar: this.state.beatsPerBar,
        downbeatOffsetSec: this.state.downbeatOffsetSec,
      });
    } catch {
      this.state.status = "failed";
      // 실패해도 앱은 멈추지 않음 — 기본값으로 사용자 수동 입력 가능
    }
    this.emit();
  }

  private runWorker(audio: AudioIn): Promise<number> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./bpm-worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = w;
      const cleanup = () => {
        w.terminate();
        if (this.worker === w) this.worker = null;
      };
      w.onmessage = (
        ev: MessageEvent<
          { type: "done"; bpm: number } | { type: "error"; message: string }
        >,
      ) => {
        if (ev.data.type === "done") {
          cleanup();
          resolve(ev.data.bpm);
        } else {
          cleanup();
          reject(new Error(ev.data.message));
        }
      };
      w.onerror = (err) => {
        cleanup();
        reject(new Error(err.message || "bpm worker error"));
      };
      w.postMessage(audio, [audio.drumsL.buffer, audio.drumsR.buffer]);
    });
  }

  private cancelWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // ── 사용자 보정(곡별 영구 저장 + 즉시 emit) ────────────────────────
  setUserBpm(n: number): void {
    const v = Math.min(240, Math.max(40, Math.round(n)));
    this.state.bpm = v;
    this.state.userTouched = true;
    this.emit();
    if (this.state.hash) void updateSongMeta(this.state.hash, { bpm: v });
  }
  setBeatsPerBar(n: number): void {
    const v = Math.min(7, Math.max(2, Math.round(n)));
    this.state.beatsPerBar = v;
    this.state.userTouched = true;
    this.emit();
    if (this.state.hash)
      void updateSongMeta(this.state.hash, { beatsPerBar: v });
  }
  setDownbeatOffsetSec(t: number): void {
    const v = Math.max(0, t);
    this.state.downbeatOffsetSec = v;
    this.state.userTouched = true;
    this.emit();
    if (this.state.hash)
      void updateSongMeta(this.state.hash, { downbeatOffsetSec: v });
  }
}

let singleton: BpmAnalyzer | null = null;
export function getBpmAnalyzer(): BpmAnalyzer {
  if (!singleton) singleton = new BpmAnalyzer();
  return singleton;
}
