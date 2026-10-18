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
  onProgress: (p: AlignProgress) => void = () => {},
  run: RunSession = onnxSession(onProgress),
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
    onProgress({ stage: "inferring", fraction: (i + 1) / chunks.length, detail: `chunk ${i + 1} of ${chunks.length}` });
  }
  return { logits, frames, vocabSize, secondsPerFrame: SECONDS_PER_FRAME };
}

/** The real inference call. Downloads and opens the model on first use, then reuses the session. `signal` cancels the download. */
export function onnxSession(onProgress: (p: AlignProgress) => void = () => {}, modelUrl = ALIGN_MODEL_URL, signal?: AbortSignal): RunSession {
  let ready: ReturnType<typeof open> | undefined;
  async function open() {
    const ort = await import("onnxruntime-web");
    onProgress({ stage: "downloading", fraction: 0 });
    const bytes = await loadModelBytes(modelUrl, (loaded, total) =>
      onProgress({ stage: "downloading", fraction: total ? loaded / total : null, detail: `${Math.round(loaded / 1e6)}${total ? ` / ${Math.round(total / 1e6)}` : ""} MB` }), signal);
    onProgress({ stage: "loading", fraction: null });
    // WASM only: the quantized graph's DynamicQuantizeLinear/MatMulInteger nodes have no WebGPU kernels in ORT Web, so WebGPU only adds partition crossings. Benchmark before re-adding it (an fp32 override is where it might help).
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "basic" });
    if (session.inputNames.length !== 1 || session.inputNames[0] !== INPUT_NAME || !session.outputNames.includes(OUTPUT_NAME))
      throw new Error(`Alignment model has inputs [${session.inputNames.join(", ")}] and outputs [${session.outputNames.join(", ")}]; expected only input "${INPUT_NAME}" and an output "${OUTPUT_NAME}".`);
    onProgress({ stage: "inferring", fraction: 0 });
    return { ort, session };
  }
  return async input => {
    ready ??= open().catch(error => { ready = undefined; throw error; });
    const { ort, session } = await ready;
    const result = await session.run({ [INPUT_NAME]: new ort.Tensor("float32", input, [1, input.length]) });
    const tensor = result[OUTPUT_NAME]!;
    return { logits: tensor.data as Float32Array, frames: tensor.dims[1] ?? 0 };
  };
}
