// 분리 결과 영구 캐시 (IndexedDB). 같은 곡(파일 내용 해시)을 다시 넣으면
// ~8분30초 재분리를 건너뛰고 즉시 연습으로 가게 한다.
// 분리/worker/istft/엔진 로직은 건드리지 않는다 — 추가 저장 계층.
//
// 무손실: Float32 PCM 그대로 + gzip(CompressionStream, 무손실) → 복원 비트 동일.
// 스토어 2분리: meta(작음, LRU/목록/touch 용) + blobs(큼, 불변).
//  → lastUsedAt 갱신마다 100MB 블롭을 재기록하지 않기 위함.

// 모델/istft 등 분리 파이프라인이 바뀌면 이 값을 올린다 → 낡은 캐시 무효화
// (4-D 에서 모델 출력이 실제로 바뀐 전례 — 낡은 결과 오재사용 차단).
export const PIPELINE_VERSION = "htdemucs+istft-4d";

const DB_NAME = "drum-room-results";
const META = "meta";
const BLOBS = "blobs";
const DB_VERSION = 1;
const MAX_BYTES = 1.2 * 1024 * 1024 * 1024; // 1.2GB 상한(승인)

export type SongMeta = {
  hash: string;
  name: string;
  durationSec: number;
  length: number; // 샘플 수(채널당)
  sampleRate: number;
  pipelineVersion: string;
  createdAt: number;
  lastUsedAt: number;
  byteSize: number; // 압축 후 4채널 합(저장 실측 footprint)
};

type BlobRec = {
  hash: string;
  compressed: boolean;
  dL: ArrayBuffer;
  dR: ArrayBuffer;
  bL: ArrayBuffer;
  bR: ArrayBuffer;
};

export type RestoredSong = {
  name: string;
  length: number;
  sampleRate: number;
  durationSec: number;
  dL: Float32Array;
  dR: Float32Array;
  bL: Float32Array;
  bR: Float32Array;
};

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) {
        const m = db.createObjectStore(META, { keyPath: "hash" });
        m.createIndex("lastUsedAt", "lastUsedAt");
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS, { keyPath: "hash" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("tx abort"));
  });
}

// ── 내용 해시 (파일명 무관 동일곡 식별). model-cache 와 같은 SHA-256 패턴. ──
export async function hashFile(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── 무손실 gzip (네이티브 CompressionStream). 미지원 시 원시 저장 폴백. ──
const HAS_CS = typeof CompressionStream !== "undefined";

async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const s = new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(s).arrayBuffer();
}
async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const s = new Blob([buf])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(s).arrayBuffer();
}

function f32ToBuf(a: Float32Array): ArrayBuffer {
  // 채널 데이터는 정확한 바이트만 떼어 독립 ArrayBuffer 로
  return a.slice(0).buffer;
}

// ── LRU: 총 byte 가 상한을 넘지 않게 오래된(lastUsedAt 작은) 곡부터 정리 ──
async function capBytes(): Promise<number> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) return Math.min(MAX_BYTES, Math.floor(est.quota * 0.5));
  } catch {
    /* estimate 미지원 — 고정 상한 사용 */
  }
  return MAX_BYTES;
}

async function allMeta(db: IDBDatabase): Promise<SongMeta[]> {
  const tx = db.transaction(META, "readonly");
  return idbReq(tx.objectStore(META).getAll() as IDBRequest<SongMeta[]>);
}

async function evictToFit(db: IDBDatabase, incoming: number): Promise<void> {
  const cap = await capBytes();
  const metas = (await allMeta(db)).sort(
    (a, b) => a.lastUsedAt - b.lastUsedAt,
  );
  let total = metas.reduce((s, m) => s + m.byteSize, 0);
  for (const m of metas) {
    if (total + incoming <= cap) break;
    await deleteSong(m.hash);
    total -= m.byteSize;
  }
}

// ── 저장 (best-effort: 호출부가 실패를 삼키고 분리·연습은 계속 진행) ──
export async function saveSong(
  meta: { hash: string; name: string },
  drums: AudioBuffer,
  backing: AudioBuffer,
): Promise<void> {
  const length = drums.length;
  const sampleRate = drums.sampleRate;
  const raw = {
    dL: f32ToBuf(drums.getChannelData(0)),
    dR: f32ToBuf(drums.getChannelData(1)),
    bL: f32ToBuf(backing.getChannelData(0)),
    bR: f32ToBuf(backing.getChannelData(1)),
  };
  const compressed = HAS_CS;
  const enc = compressed
    ? {
        dL: await gzip(raw.dL),
        dR: await gzip(raw.dR),
        bL: await gzip(raw.bL),
        bR: await gzip(raw.bR),
      }
    : raw;
  const byteSize =
    enc.dL.byteLength + enc.dR.byteLength + enc.bL.byteLength + enc.bR.byteLength;

  const db = await openDb();
  await evictToFit(db, byteSize);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tx = db.transaction([META, BLOBS], "readwrite");
      const now = Date.now();
      const m: SongMeta = {
        hash: meta.hash,
        name: meta.name,
        durationSec: length / sampleRate,
        length,
        sampleRate,
        pipelineVersion: PIPELINE_VERSION,
        createdAt: now,
        lastUsedAt: now,
        byteSize,
      };
      const b: BlobRec = { hash: meta.hash, compressed, ...enc };
      tx.objectStore(META).put(m);
      tx.objectStore(BLOBS).put(b);
      await txDone(tx);
      return;
    } catch (e) {
      // 용량 초과 → 가장 오래된 곡 비우고 재시도. 그래도 안 되면 포기.
      if (
        e instanceof DOMException &&
        (e.name === "QuotaExceededError" || e.name === "ConstraintError")
      ) {
        const oldest = (await allMeta(db)).sort(
          (a, c) => a.lastUsedAt - c.lastUsedAt,
        )[0];
        if (!oldest) throw e;
        await deleteSong(oldest.hash);
        continue;
      }
      throw e;
    }
  }
  throw new Error("결과 저장 실패(용량). 분리·연습은 계속됩니다.");
}

// ── 조회 (히트 시 lastUsedAt 만 작은 meta 쓰기로 갱신 — 블롭 재기록 없음) ──
export async function getCachedSong(
  hash: string,
): Promise<RestoredSong | null> {
  const db = await openDb();
  const rtx = db.transaction([META, BLOBS], "readonly");
  const meta = (await idbReq(
    rtx.objectStore(META).get(hash) as IDBRequest<SongMeta | undefined>,
  )) as SongMeta | undefined;
  if (!meta) return null;
  if (meta.pipelineVersion !== PIPELINE_VERSION) {
    await deleteSong(hash); // 파이프라인 바뀜 → 낡은 결과 폐기, 재분리
    return null;
  }
  const blob = (await idbReq(
    rtx.objectStore(BLOBS).get(hash) as IDBRequest<BlobRec | undefined>,
  )) as BlobRec | undefined;
  if (!blob) return null;

  const dec = async (a: ArrayBuffer) =>
    new Float32Array(blob.compressed ? await gunzip(a) : a);

  const restored: RestoredSong = {
    name: meta.name,
    length: meta.length,
    sampleRate: meta.sampleRate,
    durationSec: meta.durationSec,
    dL: await dec(blob.dL),
    dR: await dec(blob.dR),
    bL: await dec(blob.bL),
    bR: await dec(blob.bR),
  };

  try {
    const wtx = db.transaction(META, "readwrite");
    wtx.objectStore(META).put({ ...meta, lastUsedAt: Date.now() });
    await txDone(wtx);
  } catch {
    /* lastUsedAt 갱신 실패는 치명적 아님 */
  }
  return restored;
}

export async function listSongs(): Promise<SongMeta[]> {
  try {
    const db = await openDb();
    const metas = await allMeta(db);
    return metas.sort((a, b) => b.lastUsedAt - a.lastUsedAt); // 최근 먼저
  } catch {
    return [];
  }
}

export async function deleteSong(hash: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, BLOBS], "readwrite");
  tx.objectStore(META).delete(hash);
  tx.objectStore(BLOBS).delete(hash);
  await txDone(tx);
}
