// htdemucs 스펙트럼 분기 복원용 ISTFT.
// 모델 출력은 시간분기 add_77 과 스펙트럼분기 add_76(cac 복소 스펙)뿐 —
// _mask/_ispec/합산은 ONNX 밖이라 host 가 한다. demucs htdemucs._mask(cac)
// + _ispec + spec.py ispectro 를 stft.ts 의 normalized=True(1/√NFFT) 규약과
// 짝맞춰 정확히 재현(torch.istft 등가). Python ground truth 와 게이트 검증.
import { NFFT, HOP, SEG, FREQS, FRAMES } from "./stft";

const N2 = NFFT >> 1; // 2048 = 마지막(나이키스트) bin / torch center pad
const FRAMES_PAD = FRAMES + 4; // 435: _ispec 의 F.pad((2,2)) 로 양끝 2프레임
// torch.istft OLA 버퍼 길이 = (frames-1)*hop + nfft, 그 뒤 center N2 트림
const OLA_LEN = (FRAMES_PAD - 1) * HOP + NFFT; // 448512
// _ispec 최종 절단 시작 = center 트림(N2) + pad(hop/2*3=1536)
const TRIM0 = N2 + (HOP >> 1) * 3; // 3584  → [TRIM0, TRIM0+SEG)

// torch.hann_window(NFFT) periodic (stft.ts 와 동일 분석/합성 창)
const HANN = new Float64Array(NFFT);
for (let n = 0; n < NFFT; n++) {
  HANN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NFFT);
}

// 반복 radix-2 FFT (size 4096). inverse=true 면 +부호 트위들(스케일 없음).
const BITS = Math.log2(NFFT) | 0;
const REV = new Uint16Array(NFFT);
for (let i = 0; i < NFFT; i++) {
  let x = i;
  let r = 0;
  for (let b = 0; b < BITS; b++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  REV[i] = r;
}
const ICOS = new Float64Array(NFFT / 2);
const ISIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  ICOS[i] = Math.cos((2 * Math.PI * i) / NFFT); // 역방향(부호 +)
  ISIN[i] = Math.sin((2 * Math.PI * i) / NFFT);
}

function ifftCore(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < NFFT; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const half = len >> 1;
    const step = NFFT / len;
    for (let i = 0; i < NFFT; i += len) {
      for (let k = 0, idx = 0; k < half; k++, idx += step) {
        const c = ICOS[idx];
        const s = ISIN[idx];
        const ar = re[i + k + half];
        const ai = im[i + k + half];
        const tr = ar * c - ai * s;
        const ti = ar * s + ai * c;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

// torch.stft normalized=True 의 정확한 역(stft.ts forward 와 동일 1/√NFFT).
const NORM = 1 / Math.sqrt(NFFT);
const EPS = 1e-11; // torch.istft 의 window-envelope 0분모 가드

// window-envelope Σw²: torch.istft 는 F.pad((2,2)) 로 늘어난 전체 435프레임
// (제로프레임 포함)에 대해 분모를 누적한다 → 데이터와 무관, 1회 사전계산.
const ENV = new Float64Array(OLA_LEN);
for (let p = 0; p < FRAMES_PAD; p++) {
  const start = p * HOP;
  for (let n = 0; n < NFFT; n++) ENV[start + n] += HANN[n] * HANN[n];
}

// 재사용 버퍼 (청크/소스/채널 루프에서 반복 할당 방지)
const reBuf = new Float64Array(NFFT);
const imBuf = new Float64Array(NFFT);
const acc = new Float64Array(OLA_LEN);

/**
 * 한 (소스,채널)의 onesided 복소 스펙(FREQS×FRAMES) → 시간파형 SEG 샘플.
 * demucs _ispec: 나이키스트 bin 0복원(2048→2049) + 프레임 2칸 양패딩 →
 * torch.istft(normalized,center) → [N2:..][pad:pad+SEG] 절단.
 * @param a76  add_76 flat Float32 ([1,4,4,2048,431] C-order)
 * @param src  0..3, @param ch 0..1
 * @param out  SEG 길이 출력(이 채널의 스펙트럼분기 파형)
 */
function ispecSourceChannel(
  a76: Float32Array,
  src: number,
  ch: number,
  out: Float32Array,
): void {
  acc.fill(0);
  // cac 디코드: add_76 cac 인덱스 = ch*2 + reim (real=0, imag=1).
  // flat idx(s,cac,fr,t) = ((s*4 + cac)*FREQS + fr)*FRAMES + t
  const baseR = (src * 4 + ch * 2 + 0) * FREQS;
  const baseI = (src * 4 + ch * 2 + 1) * FREQS;

  for (let p = 0; p < FRAMES_PAD; p++) {
    const t = p - 2; // 패딩 프레임 → 원본 프레임(0..FRAMES-1), 그 밖은 무음
    if (t < 0 || t >= FRAMES) continue;
    // 풀 스펙트럼(Hermitian). q=0..2047 데이터, q=2048(나이키스트)=0,
    // q=2049..4095 = conj(q' = NFFT-q).
    for (let q = 0; q < N2; q++) {
      const o = (baseR + q) * FRAMES + t;
      const oi = (baseI + q) * FRAMES + t;
      reBuf[q] = a76[o];
      imBuf[q] = a76[oi];
    }
    reBuf[N2] = 0;
    imBuf[N2] = 0;
    for (let q = N2 + 1; q < NFFT; q++) {
      const src_q = NFFT - q;
      reBuf[q] = reBuf[src_q];
      imBuf[q] = -imBuf[src_q];
    }
    ifftCore(reBuf, imBuf); // 비정규 IDFT(+부호), 스케일은 NORM 으로
    const start = p * HOP;
    for (let n = 0; n < NFFT; n++) {
      acc[start + n] += HANN[n] * (reBuf[n] * NORM); // 합성창 가중 OLA
    }
  }

  for (let i = 0; i < SEG; i++) {
    const t = TRIM0 + i;
    const e = ENV[t];
    out[i] = e > EPS ? acc[t] / e : 0;
  }
}

/**
 * add_76(스펙트럼분기) → 4소스×2채널 시간파형, layout 은 add_77 과 동일
 * ((src*2+ch)*SEG + i). 호출부는 add_77 에 그대로 가산하면 된다.
 */
export function spectralWaveform(a76: Float32Array): Float32Array {
  const xspec = new Float32Array(4 * 2 * SEG);
  const ch = new Float32Array(SEG);
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < 2; c++) {
      ispecSourceChannel(a76, s, c, ch);
      xspec.set(ch, (s * 2 + c) * SEG);
    }
  }
  return xspec;
}
