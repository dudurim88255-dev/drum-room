"use client";

// 4-B 검증 전용 라우트 (UI 흐름 아님 — 출시 전 제거/가드 대상).
// 헤드리스 하니스가 window.__sepTest.run() 으로 브라우저 분리 파이프라인을
// 실행하고 Python ground truth 와 수치 대조한다.
import { useEffect } from "react";
import * as ort from "onnxruntime-web";
import { buildSpec, SEG } from "@/lib/stft";
import { separateFile } from "@/lib/separation-engine";

function parseNpy(buf: ArrayBuffer) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const major = b[6];
  const hlen = major >= 2 ? dv.getUint32(8, true) : dv.getUint16(8, true);
  const hstart = major >= 2 ? 12 : 10;
  let header = "";
  for (let i = hstart; i < hstart + hlen; i++) header += String.fromCharCode(b[i]);
  const shape = header
    .match(/'shape':\s*\(([^)]*)\)/)![1]
    .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const data = new Float32Array(buf, hstart + hlen);
  return { shape, data };
}

declare global {
  interface Window {
    __sepTest?: {
      run: (m: string, a: string, r: string) => Promise<unknown>;
      runSingle: (m: string, a: string, r: string) => Promise<unknown>;
      runRaw: (m: string, a: string, r: string) => Promise<unknown>;
    };
  }
}

// 16-bit PCM WAV 직접 파싱 → 리샘플 없는 네이티브 Float32 (L,R,sr)
function parseWav(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  let off = 12; // 'RIFF'....'WAVE'
  let fmt: { ch: number; rate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = String.fromCharCode(
      dv.getUint8(off), dv.getUint8(off + 1),
      dv.getUint8(off + 2), dv.getUint8(off + 3),
    );
    const sz = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        ch: dv.getUint16(off + 10, true),
        rate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = sz;
      break;
    }
    off += 8 + sz + (sz % 2);
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16) throw new Error("wav parse");
  const frames = dataLen / (fmt.ch * 2);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * fmt.ch * 2;
    L[i] = dv.getInt16(base, true) / 32768;
    R[i] = fmt.ch > 1 ? dv.getInt16(base + 2, true) / 32768 : L[i];
  }
  return { L, R, sr: fmt.rate };
}

// 두 신호의 일치도: errRMS / signalRMS / cosine. (드리프트 vs 버그 판별)
function compare(y: Float32Array, ref: Float32Array, n: number) {
  let dot = 0;
  let ny = 0;
  let nr = 0;
  let eSq = 0;
  let rSq = 0;
  let maxAbs = 0;
  for (let k = 0; k < n; k++) {
    const a = y[k];
    const b = ref[k];
    dot += a * b;
    ny += a * a;
    nr += b * b;
    const d = a - b;
    eSq += d * d;
    rSq += b * b;
    const ad = Math.abs(d);
    if (ad > maxAbs) maxAbs = ad;
  }
  return {
    maxAbs,
    errRms: Math.sqrt(eSq / n),
    refRms: Math.sqrt(rSq / n),
    cos: dot / (Math.sqrt(ny) * Math.sqrt(nr) || 1),
  };
}

export default function SepTest() {
  useEffect(() => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";

    window.__sepTest = {
      run: async (modelUrl, audioUrl, refUrl) => {
        const mb = await (await fetch(modelUrl)).arrayBuffer();
        const ab = await (await fetch(audioUrl)).arrayBuffer();
        const ref = parseNpy(await (await fetch(refUrl)).arrayBuffer());

        // Python soundfile 과 동일하게 네이티브 44100 PCM 직접 파싱
        const { L, R } = parseWav(ab);
        const cl = new Float32Array(SEG);
        const cr = new Float32Array(SEG);
        for (let i = 0; i < Math.min(SEG, L.length); i++) {
          cl[i] = L[i];
          cr[i] = R[i];
        }
        const mix = new Float32Array(2 * SEG);
        mix.set(cl, 0);
        mix.set(cr, SEG);
        const spec = buildSpec(cl, cr);
        const sess = await ort.InferenceSession.create(new Uint8Array(mb), {
          executionProviders: ["wasm"],
        });
        const [iMix, iSpec] = sess.inputNames;
        const o = await sess.run({
          [iMix]: new ort.Tensor("float32", mix, [1, 2, SEG]),
          [iSpec]: new ort.Tensor("float32", spec, [1, 2, 2048, 431, 2]),
        });
        const y = (o["add_77"] ?? o[sess.outputNames[1]])
          .data as Float32Array;
        await sess.release();
        const scDrums = compare(y, ref.data, 2 * SEG); // src0
        const scAll = compare(y, ref.data, y.length);

        // ── 멀티 청크: 실제 엔진 경로 separateFile (44100 디코드 수정 포함) ──
        let ticks = 0;
        let lastTotal = 0;
        const res = await separateFile(ab.slice(0), mb, {
          onProgress: (_c, t) => {
            ticks++;
            lastTotal = t;
          },
        });
        const dCh = res.drumsBuffer.getChannelData(0);
        const bCh = res.backingBuffer.getChannelData(0);
        const STRIDE = Math.floor(SEG * 0.75); // 330750
        // [0,STRIDE) 는 chunk0 만 기여 → Python ref drums(ch0)와 직접 비교 가능
        const mcCmp = compare(dCh, ref.data, STRIDE);
        let dSq = 0;
        let bSq = 0;
        let mSq = 0;
        for (let i = 0; i < dCh.length; i++) {
          dSq += dCh[i] * dCh[i];
          bSq += bCh[i] * bCh[i];
        }
        for (let i = 0; i < L.length; i++) mSq += L[i] * L[i];
        let seamJump = 0;
        for (let i = STRIDE - 50; i < STRIDE + 50 && i + 1 < dCh.length; i++) {
          seamJump = Math.max(seamJump, Math.abs(dCh[i + 1] - dCh[i]));
        }
        let typJump = 0;
        for (let i = 1000; i < 1100; i++) {
          typJump = Math.max(typJump, Math.abs(dCh[i + 1] - dCh[i]));
        }

        return {
          refShape: ref.shape,
          singleChunk: { drums: scDrums, all: scAll },
          multiChunk: {
            drumsLen: res.drumsBuffer.length,
            backingLen: res.backingBuffer.length,
            progressTicks: ticks,
            chunks: lastTotal,
            firstRegionVsPython: mcCmp, // cos~1 이어야 멀티청크 내용 정확
            drumsRms: Math.sqrt(dSq / dCh.length),
            backingRms: Math.sqrt(bSq / bCh.length),
            mixRms: Math.sqrt(mSq / L.length),
            seamJump,
            typJump,
          },
        };
      },

      // 단일청크만: 브라우저 ORT-web vs Python ORT 일치도 정밀 측정
      runSingle: async (modelUrl, audioUrl, refUrl) => {
        const mb = await (await fetch(modelUrl)).arrayBuffer();
        const ab = await (await fetch(audioUrl)).arrayBuffer();
        const ref = parseNpy(await (await fetch(refUrl)).arrayBuffer());
        const ctx = new AudioContext();
        const dec = await ctx.decodeAudioData(ab.slice(0));
        const Lf = dec.getChannelData(0);
        const Rf = dec.numberOfChannels > 1 ? dec.getChannelData(1) : Lf;
        const cl = new Float32Array(SEG);
        const cr = new Float32Array(SEG);
        for (let i = 0; i < Math.min(SEG, Lf.length); i++) {
          cl[i] = Lf[i];
          cr[i] = Rf[i];
        }
        const mix = new Float32Array(2 * SEG);
        mix.set(cl, 0);
        mix.set(cr, SEG);
        const spec = buildSpec(cl, cr);
        const sess = await ort.InferenceSession.create(new Uint8Array(mb), {
          executionProviders: ["wasm"],
        });
        const [iMix, iSpec] = sess.inputNames;
        const o = await sess.run({
          [iMix]: new ort.Tensor("float32", mix, [1, 2, SEG]),
          [iSpec]: new ort.Tensor("float32", spec, [1, 2, 2048, 431, 2]),
        });
        const y = (o["add_77"] ?? o[sess.outputNames[1]])
          .data as Float32Array;
        await sess.release();
        return {
          drums: compare(y, ref.data, 2 * SEG), // src0
          all: compare(y, ref.data, y.length),
        };
      },

      // 리샘플 없는 네이티브 44100 PCM 경로 (decodeAudioData 우회) + sr 진단
      runRaw: async (modelUrl, audioUrl, refUrl) => {
        const mb = await (await fetch(modelUrl)).arrayBuffer();
        const ab = await (await fetch(audioUrl)).arrayBuffer();
        const ref = parseNpy(await (await fetch(refUrl)).arrayBuffer());
        const acSr = new AudioContext().sampleRate; // 진단: 시스템 컨텍스트 SR
        const { L, R, sr } = parseWav(ab);
        const cl = new Float32Array(SEG);
        const cr = new Float32Array(SEG);
        for (let i = 0; i < Math.min(SEG, L.length); i++) {
          cl[i] = L[i];
          cr[i] = R[i];
        }
        const mix = new Float32Array(2 * SEG);
        mix.set(cl, 0);
        mix.set(cr, SEG);
        const spec = buildSpec(cl, cr);
        const sess = await ort.InferenceSession.create(new Uint8Array(mb), {
          executionProviders: ["wasm"],
        });
        const [iMix, iSpec] = sess.inputNames;
        const o = await sess.run({
          [iMix]: new ort.Tensor("float32", mix, [1, 2, SEG]),
          [iSpec]: new ort.Tensor("float32", spec, [1, 2, 2048, 431, 2]),
        });
        const y = (o["add_77"] ?? o[sess.outputNames[1]])
          .data as Float32Array;
        await sess.release();
        return {
          audioContextSampleRate: acSr,
          wavSampleRate: sr,
          drums: compare(y, ref.data, 2 * SEG),
          all: compare(y, ref.data, y.length),
        };
      },
    };
  }, []);

  return <div data-sep-test-ready="1">sep-test harness ready</div>;
}
