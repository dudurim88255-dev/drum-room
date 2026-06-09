// 메트로놈 박자/세분화/강세 — 2차-9 Step 2.
//
// 순수 함수(AudioContext 무관). 엔진 스케줄러 + 단위 테스트가 공유.
//
// v2 lock 적용:
// - L2 tempo 내부 표준 = 4분음표 BPM. 표시 단위는 박자표 파생(beatUnit):
//   simple-quarter=4분, compound=점4분, eighth-grid=8분.
//   q = display × {1, 1.5, 0.5}  (각 type 별 변환식).
// - L3 스케줄 격자 = 최소 펄스(felt 박 아님). 7/8 = 균등 8분 + 강세 위치로 그룹 표현.
//   t = anchor + index × subInterval (multiplicative, 누적합 아님 — Step 2 Phase A 주의 A).
//   sample-round = round(t × SR) / SR.
// - L4 박자 모델 = {numerator, denominator, type, grouping[], subdivisionLadder} +
//   독립 accents[] (길이 = grouping.length = group-starts 수).
//   복합 자연 사다리 {1,3,6}('2' 제외, 폴리리듬 범위 밖 — 정밀 스펙 #3).
//
// 클릭 레벨 매핑:
//   0=mute(스케줄 안 함) / 1=weak / 2=mid / 3=strong / softest(=base 내부 하위 틱)
//   strong(Step 1 accent 1500Hz) · mid(Step 1 beat 900Hz)는 4/4 회귀 보장(같은 버퍼).
//   weak·softest 는 Step 2 신규 버퍼. 음색 미세값은 Step 3 청취 튜닝.

export type MeterType = "simple-quarter" | "compound" | "eighth-grid";

export type MeterPreset = {
  key: string; // "4/4", "7/8", "6/8" 등 — UI 매칭용
  numerator: number;
  denominator: 4 | 8;
  type: MeterType;
  grouping: readonly number[]; // base unit 묶음 정의(길이 = #group-starts)
  subdivisionLadder: readonly number[]; // 허용 세분화(박자별 가변)
};

export type AccentLevel = 0 | 1 | 2 | 3; // 사용자 보정 가능. accents 배열의 원소.
export type PulseKind = "mute" | "weak" | "mid" | "strong" | "softest";

export type Pulse = {
  /** 바 시작점 기준 상대 시각(초). 절대 시각은 호출자가 barStartTime 가산. */
  tSec: number;
  kind: PulseKind;
};

// ── 12 프리셋 (시각 스펙 락) ─────────────────────────────────────────────
/**
 * simple-quarter 박자 preset 을 numerator 로 동적 구성.
 * PRESET_TABLE 의 1/4..6/4 와 등가. legacy `setBeatsPerBar` 가 [2,7] 받으므로
 * 7/4 같은 12 프리셋 외 값도 안전하게 만들 수 있게 export.
 */
export function makeSimpleQuarterPreset(num: number): MeterPreset {
  return {
    key: `${num}/4`,
    numerator: num,
    denominator: 4,
    type: "simple-quarter",
    grouping: Array(num).fill(1),
    subdivisionLadder: [1, 2, 3, 4, 6],
  };
}
const simpleQuarter = makeSimpleQuarterPreset;
function eighthGrid(num: number, grouping: readonly number[]): MeterPreset {
  return {
    key: `${num}/8`,
    numerator: num,
    denominator: 8,
    type: "eighth-grid",
    grouping,
    subdivisionLadder: [1, 2, 4],
  };
}
function compound(num: number, grouping: readonly number[]): MeterPreset {
  return {
    key: `${num}/8`,
    numerator: num,
    denominator: 8,
    type: "compound",
    grouping,
    subdivisionLadder: [1, 3, 6], // 복합 자연 사다리 — "2"(2:3 폴리리듬) 제외
  };
}

export const PRESET_TABLE: Record<string, MeterPreset> = Object.freeze({
  "1/4": simpleQuarter(1),
  "2/4": simpleQuarter(2),
  "3/4": simpleQuarter(3),
  "4/4": simpleQuarter(4),
  "5/4": simpleQuarter(5),
  "6/4": simpleQuarter(6),
  "3/8": eighthGrid(3, [1, 1, 1]),
  "5/8": eighthGrid(5, [3, 2]),
  "7/8": eighthGrid(7, [2, 3, 2]),
  "6/8": compound(6, [3, 3]),
  "9/8": compound(9, [3, 3, 3]),
  "12/8": compound(12, [3, 3, 3, 3]),
});

// ── 변환: 표시 BPM ↔ 4분음표 BPM ─────────────────────────────────────────
export function displayBpmToQuarter(
  displayBpm: number,
  type: MeterType,
): number {
  switch (type) {
    case "simple-quarter":
      return displayBpm;
    case "compound":
      return displayBpm * 1.5;
    case "eighth-grid":
      return displayBpm / 2;
  }
}
export function quarterBpmToDisplay(
  quarterBpm: number,
  type: MeterType,
): number {
  switch (type) {
    case "simple-quarter":
      return quarterBpm;
    case "compound":
      return quarterBpm / 1.5;
    case "eighth-grid":
      return quarterBpm * 2;
  }
}

/**
 * base unit 길이(초). simple-quarter=4분, compound=점4분, eighth-grid=8분.
 * 모두 quarterBpm 기준(60/q)에서 type 별 배율 적용.
 */
export function baseUnitDurSec(type: MeterType, quarterBpm: number): number {
  const q = 60 / quarterBpm;
  switch (type) {
    case "simple-quarter":
      return q;
    case "compound":
      return q * 1.5;
    case "eighth-grid":
      return q * 0.5;
  }
}

/**
 * 바당 base unit 개수.
 * simple-quarter/eighth-grid: numerator(분자=4분/8분 개수).
 * compound: grouping.length(=점4분 개수, 예 6/8 → 2).
 */
export function baseCountPerBar(meter: MeterPreset): number {
  return meter.type === "compound" ? meter.grouping.length : meter.numerator;
}

/** 바당 펄스(=tick) 개수 = base unit 개수 × subdivision. */
export function ticksPerBar(meter: MeterPreset, subdivision: number): number {
  return baseCountPerBar(meter) * Math.max(1, Math.floor(subdivision));
}

/** 바 길이(초) — 그 바의 meter/q 기준. Step 2 Cautionary C 의 핵심. */
export function barLengthSec(meter: MeterPreset, quarterBpm: number): number {
  return baseCountPerBar(meter) * baseUnitDurSec(meter.type, quarterBpm);
}

/** group-starts 의 base-unit 인덱스 배열. 예 7/8 grouping=[2,3,2] → [0, 2, 5]. */
export function groupStartBaseIndices(meter: MeterPreset): number[] {
  // simple-quarter, compound: 모든 base 가 group-start
  if (meter.type !== "eighth-grid") {
    const n = baseCountPerBar(meter);
    return Array.from({ length: n }, (_, i) => i);
  }
  // eighth-grid: grouping 누적합
  const out: number[] = [];
  let cum = 0;
  for (const g of meter.grouping) {
    out.push(cum);
    cum += g;
  }
  return out;
}

function accentLevelToKind(level: AccentLevel): PulseKind {
  switch (level) {
    case 0:
      return "mute";
    case 1:
      return "weak";
    case 2:
      return "mid";
    case 3:
      return "strong";
  }
}

/**
 * 바 내 펄스 인덱스(0..ticksPerBar-1) → PulseKind.
 * 분기:
 *   - base 시작점(idxInBar % S === 0) 이면서 group 시작 → accents[groupIdx]
 *   - base 시작점이지만 그룹 비시작(eighth-grid 만 해당) → weak
 *   - base 내부 하위 틱(S > 1 일 때) → softest
 * 엔진 스케줄러·단위 테스트 둘 다 이 함수로 kind 결정.
 */
export function pulseKindAt(
  tickIdxInBar: number,
  meter: MeterPreset,
  subdivision: number,
  accents: readonly AccentLevel[],
): PulseKind {
  const S = Math.max(1, Math.floor(subdivision));
  const isBaseStart = tickIdxInBar % S === 0;
  if (!isBaseStart) return "softest";
  const baseIdx = tickIdxInBar / S;
  const gStarts = groupStartBaseIndices(meter);
  const gIdx = gStarts.indexOf(baseIdx);
  if (gIdx >= 0) {
    const level = accents[gIdx] ?? 0;
    return accentLevelToKind(level);
  }
  // eighth-grid 의 그룹 비시작 base — weak
  return "weak";
}

/**
 * 한 바의 모든 펄스 (tSec, kind) 시퀀스 — 순수 함수.
 * 시각 = anchor 0 기준 multiplicative: tSec_i = i × subInterval.
 * sample-round = round(tSec × SR) / SR (정수 샘플).
 * mute 레벨도 시퀀스에 포함(호출자가 스킵 가능; 단위 테스트는 위치 검증 위해 필요).
 *
 * @param meter 박자 프리셋
 * @param subdivision 1, 2, 3, 4, 6 등 (박자 ladder 안에서)
 * @param accents 길이 = grouping.length
 * @param quarterBpm 내부 4분음표 BPM
 * @param sampleRate AudioContext SR (정수 샘플 round)
 */
export function generateBarPulses(
  meter: MeterPreset,
  subdivision: number,
  accents: readonly AccentLevel[],
  quarterBpm: number,
  sampleRate: number,
): Pulse[] {
  const S = Math.max(1, Math.floor(subdivision));
  const tpb = ticksPerBar(meter, S);
  const subInterval = baseUnitDurSec(meter.type, quarterBpm) / S;
  const pulses: Pulse[] = [];
  for (let i = 0; i < tpb; i++) {
    const tRaw = i * subInterval;
    const tSec = Math.round(tRaw * sampleRate) / sampleRate;
    const kind = pulseKindAt(i, meter, S, accents);
    pulses.push({ tSec, kind });
  }
  return pulses;
}

/** simple-quarter 박자 기본 강세: [강, 중, 중, ...]. */
export function defaultAccents(meter: MeterPreset): AccentLevel[] {
  const k = meter.grouping.length;
  const out: AccentLevel[] = new Array(k).fill(2 as AccentLevel);
  if (k > 0) out[0] = 3;
  return out;
}
