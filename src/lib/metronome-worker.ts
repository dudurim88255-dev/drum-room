/// <reference lib="webworker" />
// 메트로놈 lookahead 타이머 — 메인 jank·GC 로부터 클럭 보호("A Tale of Two Clocks").
// 자기 일은 setInterval(intervalMs) → postMessage('tick') 뿐.
// 실제 osc/buffer 예약은 메인이 tick 받아서 한다(AudioContext API 는 메인 전용).
// 메인이 UI 렌더·GC 로 정체돼도 worker setInterval 은 영향 받지 않는다.

type InMsg =
  | { type: "start"; intervalMs: number }
  | { type: "stop" };

let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<InMsg>) => {
  const m = e.data;
  if (m.type === "start") {
    if (timer != null) clearInterval(timer);
    timer = setInterval(() => {
      (self as DedicatedWorkerGlobalScope).postMessage({ type: "tick" });
    }, m.intervalMs);
  } else if (m.type === "stop") {
    if (timer != null) clearInterval(timer);
    timer = null;
  }
};

export {};
