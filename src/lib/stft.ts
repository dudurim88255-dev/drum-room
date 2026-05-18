// demucs htdemucs 가 기대하는 spec 입력을 만드는 STFT.
// demucs.spec.spectro + convert_to_onnx._spec (nfft=4096, hop=1024, hann periodic,
// normalized=True, center=True, reflect) 를 정확히 재현.
// 이 구현은 Python torch ground truth 와 max abs err 9.5e-7 로 검증됨(4-B 게이트).

export const NFFT = 4096;
export const HOP = 1024;
export const SEG = 441000; // 정확히 10초 @ 44100Hz
export const FREQS = NFFT / 2; // 2048 (마지막 bin drop)
export const FRAMES = Math.ceil(SEG / HOP); // 431

// torch F.pad 'reflect' (경계 미반복) 인덱스
function reflectIdx(i: number, L: number): number {
  if (L === 1) return 0;
  const period = 2 * (L - 1);
  const m = ((i % period) + period) % period;
  return m < L ? m : period - m;
}

// torch.hann_window(NFFT) 기본 periodic=True
const HANN = new Float64Array(NFFT);
for (let n = 0; n < NFFT; n++) {
  HANN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NFFT);
}

// 반복 radix-2 FFT (size 4096 = 2^12)
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
const COS = new Float64Array(NFFT / 2);
const SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / NFFT); // 정방향(부호 -)
  SIN[i] = Math.sin((-2 * Math.PI * i) / NFFT);
}

function fft(re: Float64Array, im: Float64Array): void {
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
        const c = COS[idx];
        const s = SIN[idx];
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

const NORM = 1 / Math.sqrt(NFFT); // torch.stft normalized=True

/**
 * 채널 1개(정확히 SEG=441000 샘플) → spec [FREQS, FRAMES, 2] (C-order, re/im).
 * 호출부가 [1,2,FREQS,FRAMES,2] 로 두 채널을 이어붙인다.
 */
export function specOfChannel(sig: Float64Array | Float32Array): Float32Array {
  const padL = (HOP >> 1) * 3; // 1536
  const padR = padL + FRAMES * HOP - SEG; // 1880
  const L1 = SEG + padL + padR; // 444416
  const C = NFFT >> 1; // 2048 (torch.stft center pad)
  const Lc = L1 + 2 * C; // 448512

  const ext = new Float64Array(Lc);
  for (let k = 0; k < Lc; k++) {
    const i1 = k - C; // padded1 좌표
    const i0 = reflectIdx(i1 - padL, SEG); // 원본 좌표
    ext[k] = sig[i0];
  }
  const totalFrames = 1 + (((Lc - NFFT) / HOP) | 0); // 435 = FRAMES+4
  if (totalFrames !== FRAMES + 4) {
    throw new Error(`STFT frames ${totalFrames} != ${FRAMES + 4}`);
  }

  const out = new Float32Array(FREQS * FRAMES * 2);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  for (let f = 0; f < FRAMES; f++) {
    const base = (f + 2) * HOP; // z[..., 2:2+le]
    for (let n = 0; n < NFFT; n++) {
      re[n] = ext[base + n] * HANN[n];
      im[n] = 0;
    }
    fft(re, im);
    for (let q = 0; q < FREQS; q++) {
      const o = (q * FRAMES + f) * 2;
      out[o] = re[q] * NORM;
      out[o + 1] = im[q] * NORM;
    }
  }
  return out;
}

/**
 * 스테레오 청크(정확히 SEG 샘플) → spec Float32Array, shape [1,2,FREQS,FRAMES,2].
 */
export function buildSpec(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  const per = FREQS * FRAMES * 2;
  const spec = new Float32Array(2 * per);
  spec.set(specOfChannel(left), 0);
  spec.set(specOfChannel(right), per);
  return spec;
}
