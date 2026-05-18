// htdemucs ONNX 모델 확보: 첫 방문 1회 외부 fetch(진행률) + sha256 검증 +
// Cache API 저장. 2회차부터 캐시에서 즉시(재다운로드 없음).
//
// 출처는 4-A 에서 검증한 공개 Git LFS (CORS '*' 확인). URL 은 상수로 분리해
// 추후 자가 호스팅으로 교체 가능.

const MODEL_URL =
  "https://media.githubusercontent.com/media/gianlourbano/demucs-onnx/main/public/htdemucs_optimized.onnx";
const MODEL_SHA256 =
  "bacfac8a892cc63515716e2eb1a652228a478bf798ecc12935a7faf708e65877";
const MODEL_BYTES = 171038235;
const CACHE_NAME = "drum-room-model-v1";

export type ModelProgress = {
  phase: "download" | "verify" | "cache" | "done";
  loaded: number;
  total: number;
};

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySha256(bytes: ArrayBuffer): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = toHex(digest);
  if (hex !== MODEL_SHA256) {
    throw new Error(
      `모델 무결성 검증 실패 (sha256 불일치: ${hex.slice(0, 12)}…)`,
    );
  }
}

/**
 * 모델 ArrayBuffer 를 반환. 캐시에 있으면 즉시, 없으면 다운로드→검증→캐시.
 * @returns { bytes, fromCache } — fromCache=true 면 재다운로드 안 함
 */
export async function loadModel(
  onProgress?: (p: ModelProgress) => void,
): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(MODEL_URL);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (bytes.byteLength === MODEL_BYTES) {
      onProgress?.({ phase: "done", loaded: MODEL_BYTES, total: MODEL_BYTES });
      return { bytes, fromCache: true };
    }
    // 캐시가 손상/불완전 → 폐기 후 재다운로드
    await cache.delete(MODEL_URL);
  }

  // COEP require-corp 환경(멀티스레드용 crossOriginIsolated)에서도 통과하도록
  // CORS 모드 명시 — 출처(media.githubusercontent.com)가 ACAO:* 를 주므로
  // (4-A 확인) cross-origin 이어도 차단되지 않는다. 막히면 자가호스팅 검토.
  let res: Response;
  try {
    res = await fetch(MODEL_URL, { mode: "cors", credentials: "omit" });
  } catch (e) {
    throw new Error(
      "모델 다운로드 실패 (네트워크/COEP 차단 가능 — 자가호스팅 검토 필요): " +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`모델 다운로드 실패 (HTTP ${res.status})`);
  }
  const total =
    Number(res.headers.get("content-length")) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ phase: "download", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  const ab = bytes.buffer;

  onProgress?.({ phase: "verify", loaded: total, total });
  await verifySha256(ab);

  onProgress?.({ phase: "cache", loaded: total, total });
  try {
    await cache.put(MODEL_URL, new Response(ab.slice(0)));
  } catch {
    // 캐시 저장 실패(용량 등)는 치명적 아님 — 이번 세션은 메모리로 진행
  }

  onProgress?.({ phase: "done", loaded: total, total });
  return { bytes: ab, fromCache: false };
}

/** 캐시에 모델이 이미 있는지 (재다운로드 스킵 여부 판단/검증용). */
export async function isModelCached(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(MODEL_URL);
  if (!hit) return false;
  const len = Number(hit.headers.get("content-length"));
  // Response(ArrayBuffer) 는 content-length 가 없을 수 있어 본문 길이로 확인
  if (len === MODEL_BYTES) return true;
  const b = await hit.arrayBuffer();
  return b.byteLength === MODEL_BYTES;
}
