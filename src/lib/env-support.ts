// 1차 지원 타깃: 크롬 데스크톱. 모바일이거나 필수 브라우저 능력이 없으면
// 본 기능 대신 안내 화면을 띄운다 (DESIGN.md §8).
export function checkSupport(): { ok: boolean; reason: string } {
  if (typeof window === "undefined") return { ok: false, reason: "ssr" };

  const w = window as unknown as Record<string, unknown>;
  const ua = navigator.userAgent || "";
  const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  const isMobile =
    uaData?.mobile === true || /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  if (isMobile) return { ok: false, reason: "mobile" };

  const has = (k: string) => typeof w[k] !== "undefined";
  if (!(has("AudioContext") || has("webkitAudioContext")))
    return { ok: false, reason: "AudioContext" };
  if (!(has("OfflineAudioContext") || has("webkitOfflineAudioContext")))
    return { ok: false, reason: "OfflineAudioContext" };
  if (!has("Worker")) return { ok: false, reason: "Web Worker" };
  if (!has("WebAssembly")) return { ok: false, reason: "WebAssembly" };
  if (!has("caches")) return { ok: false, reason: "Cache API" };
  if (!(window.crypto && window.crypto.subtle))
    return { ok: false, reason: "crypto.subtle" };

  return { ok: true, reason: "" };
}
