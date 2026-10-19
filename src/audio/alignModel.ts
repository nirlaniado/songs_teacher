import { VOCAB } from "./ctcAlign.js";
import { loadModelBytes } from "./modelCache.js";

/**
 * Runs wav2vec2 over a whole song and returns its CTC logits, for
 * `ctcAlign.forcedAlign`.
 *
 * Input is 16 kHz mono samples; decode with `decodeMono(data, [ALIGN_SAMPLE_RATE])`.
 * The song is cut into overlapping chunks because attention is O(T²), and the
 * chunks are stitched back so the result is frame-for-frame what one pass
 * over the whole song would index. Inference goes through `RunSession` so the
 * planning, normalisation and stitching are testable without the model.
 */

/** ~91MB. Overridable for a self-hosted copy or a different export. */
export const ALIGN_MODEL_URL =
  import.meta.env.VITE_ALIGN_MODEL_URL?.trim() ||
  "https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX/resolve/main/onnx/model_quantized.onnx";

export const ALIGN_SAMPLE_RATE = 16_000;
/** The conv feature encoder's total stride (5·2⁶): one output frame per 320 samples, exactly 20 ms. */
export const SAMPLES_PER_FRAME = 320;
export const SECONDS_PER_FRAME = SAMPLES_PER_FRAME / ALIGN_SAMPLE_RATE;

// 30 s keeps each pass within the utterance lengths the model was trained on; 2 s of context either side of the kept region keeps chunk edges out of the output.
const CHUNK_FRAMES = 1500;
const MARGIN_FRAMES = 100;
const CHUNK_SAMPLES = CHUNK_FRAMES * SAMPLES_PER_FRAME;
const STEP_FRAMES = CHUNK_FRAMES - 2 * MARGIN_FRAMES;

const CONV_LAYERS: ReadonlyArray<readonly [kernel: number, stride: number]> = [[10, 5], [3, 2], [3, 2], [3, 2], [3, 2], [2, 2], [2, 2]];

const INPUT_NAME = "input_values";
const OUTPUT_NAME = "logits";

export interface AlignProgress {
  stage: "downloading" | "loading" | "inferring";
  /** 0..1 within the current stage, or null when indeterminate. */
  fraction: number | null;
  detail?: string;
}

export interface Emissions {
  /** Row-major, `frames` × `vocabSize`; row i is frame i. */
  logits: Float32Array;
  frames: number;
  vocabSize: number;
  secondsPerFrame: number;
}

export type RunSession = (input: Float32Array) => Promise<{ logits: Float32Array; frames: number }>;

export interface Chunk {
  /** Sample offset; always a multiple of SAMPLES_PER_FRAME, so local frame j is global frame start/320 + j. */
  start: number;
  length: number;
  /** Global frames this chunk supplies to the output, [keepFrom, keepTo). */
  keepFrom: number;
  keepTo: number;
}

/** Output frames the model produces for `samples` input samples, following its conv stack exactly. */
export function framesFor(samples: number): number {
  let length = samples;
  for (const [kernel, stride] of CONV_LAYERS) {
    if (length < kernel) return 0;
    length = Math.floor((length - kernel) / stride) + 1;
  }
  return length;
}

export function planChunks(samples: number): Chunk[] {
  const total = framesFor(samples);
  if (total === 0) return [];
  const chunks: Chunk[] = [];
  for (let start = 0; ; start += STEP_FRAMES * SAMPLES_PER_FRAME) {
    const length = Math.min(CHUNK_SAMPLES, samples - start);
    const keepFrom = chunks.length === 0 ? 0 : start / SAMPLES_PER_FRAME + MARGIN_FRAMES;
    if (chunks.length) chunks[chunks.length - 1]!.keepTo = keepFrom;
    chunks.push({ start, length, keepFrom, keepTo: total });
    if (start + length >= samples) return chunks;
  }
}

// Normalised once over the whole song rather than per chunk (as HF does per example): per-chunk statistics would rescale the same audio differently in each chunk, a discontinuity that lands exactly on the seams being stitched. A song shorter than one chunk is one example either way.
export function normalize(samples: Float32Array): Float32Array {
  let sum = 0;
  for (const x of samples) sum += x;
  const mean = samples.length ? sum / samples.length : 0;
  let squares = 0;
  for (const x of samples) squares += (x - mean) ** 2;
  const scale = 1 / Math.sqrt((samples.length ? squares / samples.length : 0) + 1e-7);
  return samples.map(x => (x - mean) * scale);
}

/**
 * Whole-song logits for 16 kHz mono `samples`. Input too short for one frame
 * (under 400 samples, 25 ms) returns zero frames without loading the model.
 */
export async function emissionsFor(
  samples: Float32Array,
  onProgress: ((p: AlignProgress) => void) | undefined,
  run: RunSession,
): Promise<Emissions> {
  const vocabSize = VOCAB.length;
  const frames = framesFor(samples.length);
  const logits = new Float32Array(frames * vocabSize);
  const chunks = planChunks(samples.length);
  const input = chunks.length ? normalize(samples) : samples;

  // Reported after each chunk, not before: the first run() may still be downloading and loading the model, and progress must not step back from "inferring" to "downloading".
  for (const [i, chunk] of chunks.entries()) {
    const out = await run(input.subarray(chunk.start, chunk.start + chunk.length));
    const expected = framesFor(chunk.length);
    if (out.frames !== expected || out.logits.length !== expected * vocabSize)
      throw new Error(`Alignment model returned ${out.frames} frames (${out.logits.length} values) for ${chunk.length} samples; expected ${expected} × ${vocabSize}.`);
    const offset = chunk.start / SAMPLES_PER_FRAME;
    logits.set(out.logits.subarray((chunk.keepFrom - offset) * vocabSize, (chunk.keepTo - offset) * vocabSize), chunk.keepFrom * vocabSize);
    onProgress?.({ stage: "inferring", fraction: (i + 1) / chunks.length, detail: `chunk ${i + 1} of ${chunks.length}` });
  }
  return { logits, frames, vocabSize, secondsPerFrame: SECONDS_PER_FRAME };
}

/** One message to the alignment worker: the model bytes to open, or a chunk to infer. */
export type AlignRequest = { id: number; model: ArrayBuffer } | { id: number; input: Float32Array };
export type AlignReply = { id: number; error?: string; logits?: Float32Array; frames?: number };
export type AlignWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

const spawnAlignWorker = (): AlignWorker => new Worker(new URL("./alignWorker.ts", import.meta.url), { type: "module" });

/**
 * The real inference call. Downloads the model on first use, then reuses the session. `signal` cancels the download
 * and any chunk in flight. `close` releases the worker and the model's memory with it.
 *
 * ONNX Runtime's WASM backend compiles the graph and runs each chunk synchronously on whichever thread calls it, so
 * here that is a worker of our own: on the page, opening the model and every 30 s chunk froze the tab into Chrome's
 * "Page Unresponsive" dialog, and a cancel couldn't even be clicked. Its own worker, rather than ORT's proxy worker,
 * because `ort.env` is shared with stem separation and the proxy setting only takes effect before ORT's first use; and
 * because terminating the worker is the only way to stop a chunk already running. The cost is one copy of each chunk's
 * input (~1.9 MB) and logits (~190 KB) across the boundary, transferred rather than cloned, so the song's normalised
 * waveform is never copied whole and the stitched logits stay on this side as before.
 */
export function onnxSession(
  onProgress: (p: AlignProgress) => void = () => {},
  modelUrl = ALIGN_MODEL_URL,
  signal?: AbortSignal,
  spawn: () => AlignWorker = spawnAlignWorker,
): RunSession & { close(): void } {
  let worker: AlignWorker | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (reply: AlignReply) => void; reject: (error: unknown) => void }>();
  const cancelled = () => new DOMException("Analysis cancelled", "AbortError");

  function stop(error: unknown) {
    worker?.terminate();
    worker = undefined;
    ready = undefined;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  signal?.addEventListener("abort", () => stop(cancelled()), { once: true });

  function start(): AlignWorker {
    const w = spawn();
    w.onmessage = ({ data }: MessageEvent<AlignReply>) => {
      const call = pending.get(data.id);
      pending.delete(data.id);
      if (data.error === undefined) call?.resolve(data);
      else call?.reject(new Error(data.error));
    };
    w.onerror = (event: ErrorEvent) => stop(new Error(`The lyric alignment worker failed${event.message ? `: ${event.message}` : ""}.`));
    return w;
  }

  function call(request: Omit<AlignRequest, "id">, transfer: Transferable[]): Promise<AlignReply> {
    if (signal?.aborted) return Promise.reject(cancelled());
    worker ??= start();
    const id = nextId++;
    const w = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...request, id }, transfer);
    });
  }

  async function open() {
    onProgress({ stage: "downloading", fraction: 0 });
    const model = await loadModelBytes(modelUrl, (loaded, total) =>
      onProgress({ stage: "downloading", fraction: total ? loaded / total : null, detail: `${Math.round(loaded / 1e6)}${total ? ` / ${Math.round(total / 1e6)}` : ""} MB` }), signal);
    onProgress({ stage: "loading", fraction: null });
    await call({ model }, [model]);
    onProgress({ stage: "inferring", fraction: 0 });
  }

  const run: RunSession = async input => {
    ready ??= open().catch(error => { ready = undefined; throw error; });
    await ready;
    const chunk = input.slice();
    const { logits, frames } = await call({ input: chunk }, [chunk.buffer]);
    return { logits: logits!, frames: frames! };
  };
  return Object.assign(run, { close: () => stop(cancelled()) });
}

/** The worker's side of `onnxSession`: opens the model, then infers each chunk it is sent. `post` replies to the page. */
export function alignWorkerHandler(post: (reply: AlignReply, transfer: Transferable[]) => void) {
  let opened: Promise<{ ort: typeof import("onnxruntime-web"); session: import("onnxruntime-web").InferenceSession }> | undefined;
  async function open(model: ArrayBuffer) {
    const ort = await import("onnxruntime-web");
    // WASM only: the quantized graph's DynamicQuantizeLinear/MatMulInteger nodes have no WebGPU kernels in ORT Web, so WebGPU only adds partition crossings. Benchmark before re-adding it (an fp32 override is where it might help).
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"], graphOptimizationLevel: "basic" });
    if (session.inputNames.length !== 1 || session.inputNames[0] !== INPUT_NAME || !session.outputNames.includes(OUTPUT_NAME))
      throw new Error(`Alignment model has inputs [${session.inputNames.join(", ")}] and outputs [${session.outputNames.join(", ")}]; expected only input "${INPUT_NAME}" and an output "${OUTPUT_NAME}".`);
    return { ort, session };
  }
  return async (request: AlignRequest) => {
    try {
      if ("model" in request) {
        opened = open(request.model);
        await opened;
        return post({ id: request.id }, []);
      }
      if (!opened) throw new Error("The alignment model was not opened before inference.");
      const { ort, session } = await opened;
      const result = await session.run({ [INPUT_NAME]: new ort.Tensor("float32", request.input, [1, request.input.length]) });
      const tensor = result[OUTPUT_NAME]!;
      // A copy, so the buffer transferred back is one this chunk owns outright, never a view into ORT's (possibly shared) memory.
      const logits = (tensor.data as Float32Array).slice();
      post({ id: request.id, logits, frames: tensor.dims[1] ?? 0 }, [logits.buffer]);
    } catch (error) {
      post({ id: request.id, error: error instanceof Error ? error.message : String(error) }, []);
    }
  };
}
