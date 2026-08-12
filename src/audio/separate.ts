import type { StemId } from "../schema/deck.js";

/**
 * In-browser stem separation via Demucs (ONNX).
 *
 * The `demucs-web` library owns the hard parts — STFT, reflect padding,
 * segmenting the track and overlap-add reconstruction — and `separate()`
 * takes a whole song. This module handles everything around it: caching the
 * model, decoding input, and encoding output the deck can store.
 *
 * **Four stems only.** The library's `separate()` returns exactly
 * drums/bass/other/vocals. The 6-stem model that would add a guitar channel
 * has a different output shape and is not supported here, so guitar stays
 * inside "other".
 */

/** ~172MB. Overridable for a self-hosted copy or a different export. */
export const MODEL_URL =
  import.meta.env.VITE_DEMUCS_MODEL_URL?.trim() ||
  "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx";

const CACHE_NAME = "libre-off-models";

export interface SeparateProgress {
  stage: "downloading" | "loading" | "separating" | "encoding";
  /** 0..1 within the current stage, or null when indeterminate. */
  fraction: number | null;
  detail?: string;
}

export interface SeparateResult {
  id: StemId;
  data: Blob;
  ext: "wav";
}

/** True once the model is cached, so the UI can skip the download warning. */
export async function isModelCached(url = MODEL_URL): Promise<boolean> {
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
 * Worth the plumbing: without it every separation re-downloads 172MB. The
 * cache is keyed by URL, so pointing at a different export invalidates
 * naturally.
 */
async function loadModelBytes(
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

/**
 * Encodes stereo Float32 channels as a 16-bit PCM WAV.
 *
 * WAV rather than MP3/Opus deliberately: it is a few lines and no dependency,
 * and the browser has no built-in encoder for the others that doesn't involve
 * real-time `MediaRecorder` capture. The cost is size — roughly 10MB per
 * stem-minute — which is the trade documented in the README.
 */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const frames = Math.min(left.length, right.length);
  const blockAlign = 4; // 2 channels × 16-bit
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 2, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of [left, right]) {
      // Clamped before scaling: separation output can exceed ±1 slightly, and
      // letting it wrap turns a loud passage into harsh noise.
      const sample = Math.max(-1, Math.min(1, channel[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Separates one track into four stems.
 *
 * Runs on the calling thread — several minutes for a full song. Callers
 * should keep the UI responsive around it and report `onProgress`.
 */
export async function separateTrack(
  audio: ArrayBuffer,
  onProgress: (p: SeparateProgress) => void,
  modelUrl = MODEL_URL,
): Promise<SeparateResult[]> {
  const [{ DemucsProcessor }, ort] = await Promise.all([
    import("demucs-web"),
    import("onnxruntime-web"),
  ]);

  onProgress({ stage: "downloading", fraction: 0 });
  const modelBytes = await loadModelBytes(modelUrl, (loaded, total) => {
    onProgress({
      stage: "downloading",
      fraction: total ? loaded / total : null,
      detail: `${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`,
    });
  });

  onProgress({ stage: "loading", fraction: null });
  const processor = new DemucsProcessor({
    ort,
    onProgress: (fraction, current, total) =>
      onProgress({
        stage: "separating",
        fraction,
        detail: current && total ? `segment ${current} of ${total}` : undefined,
      }),
  });
  await processor.loadModel(modelBytes);

  // Decoded here rather than reusing the player's context: separation needs
  // the raw channels, and this context is closed as soon as it's done.
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(audio);
  } finally {
    void ctx.close();
  }

  const left = decoded.getChannelData(0);
  // Mono input is duplicated: the model expects two channels.
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;

  onProgress({ stage: "separating", fraction: 0 });
  const stems = await processor.separate(left, right);

  onProgress({ stage: "encoding", fraction: null });
  const ids: StemId[] = ["drums", "bass", "vocals", "other"];
  return ids.map((id) => ({
    id,
    data: encodeWav(stems[id as keyof typeof stems].left, stems[id as keyof typeof stems].right, decoded.sampleRate),
    ext: "wav" as const,
  }));
}
