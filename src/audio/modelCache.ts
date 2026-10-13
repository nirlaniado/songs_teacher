/**
 * Cache API storage for the ONNX models, shared by stem separation and lyric
 * alignment. One cache holds both, keyed by URL.
 */

// Deliberately still "libre-off": renaming it orphans the cached Demucs model and every user re-downloads 172MB.
const CACHE_NAME = "libre-off-models";

/** True once the model is cached, so the UI can skip the download warning. */
export async function isModelCached(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    return (await (await caches.open(CACHE_NAME)).match(url)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Fetches the model, serving it from the Cache API on later runs.
 *
 * Worth the plumbing: without it every run re-downloads the model (172MB for
 * Demucs, 91MB for alignment). The cache is keyed by URL, so pointing at a
 * different export invalidates naturally.
 */
export async function loadModelBytes(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;

  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Couldn't download the model (${response.status}).`);

  const total = Number(response.headers.get("Content-Length") ?? 0);
  let bytes: ArrayBuffer;
  if (!response.body || !total) {
    bytes = await response.arrayBuffer();
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    const joined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    bytes = joined.buffer;
  }

  // Cached from the finished bytes, not from a clone of the response taken up front: putting a clone waits for the
  // whole body, which held the progress above at zero until the download was over. Caching only a complete file also
  // means a cancelled or failed download never leaves a truncated model to be served next time.
  if (cache) await cache.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}
