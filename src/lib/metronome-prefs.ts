// 메트로놈 전역 사용자 선호 — 단일 버전드 객체 (2차-9 정밀 스펙 #1).
// Step 1 영속 범위 = volume 만. tempo/meter 는 곡 mirror(§5) 유지 → prefs 미보관.
// Step 3 풀 메트로놈 독립 시점에 tempo/meter/grouping/accents/sound 가 본 스키마에
// 추가될 자리. 추가 시 version 올려 마이그레이션.
const KEY = "drumroom.metronomePrefs.v1";

export type MetronomePreferences = {
  version: 1;
  volume: number; // 0..1
};

const DEFAULTS: MetronomePreferences = {
  version: 1,
  volume: 0.7,
};

/** localStorage 에서 prefs 로드. 손상/미지원 시 DEFAULTS. */
export function loadMetronomePrefs(): MetronomePreferences {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MetronomePreferences> | null;
    if (!parsed || parsed.version !== 1) return { ...DEFAULTS };
    const volume =
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? Math.min(1, Math.max(0, parsed.volume))
        : DEFAULTS.volume;
    return { version: 1, volume };
  } catch {
    return { ...DEFAULTS };
  }
}

/** prefs 영속 저장. localStorage 미지원/실패 시 무시(세션 한정 동작). */
export function saveMetronomePrefs(prefs: MetronomePreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage 무가용 — 무시 */
  }
}
