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
): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;

  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download the model (${response.status}).`);

  // Cache before consuming the body — a Response can only be read once, so
  // the clone has to be taken up front.
  if (cache) await cache.put(url, response.clone()).catch(() => {});

  const total = Number(response.headers.get("Content-Length") ?? 0);
  if (!response.body || !total) return response.arrayBuffer();

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
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
