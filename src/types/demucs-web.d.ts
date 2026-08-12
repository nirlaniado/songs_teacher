/**
 * Hand-written types for `demucs-web`, which ships plain JS with no
 * declarations. Only the surface `src/audio/separate.ts` actually uses.
 *
 * The library owns everything hard about Demucs inference — STFT (4096/1024),
 * reflect padding, segmenting a whole song, and overlap-add reconstruction.
 * `separate()` takes the entire track and handles chunking internally.
 *
 * Note `separate()` returns exactly four sources. The 6-stem model (which
 * would add guitar and piano) is **not** supported here: the output shape
 * differs and this library hardcodes four. That's why the app offers 4-stem
 * only.
 */
declare module "demucs-web" {
  export interface DemucsProcessorOptions {
    /** The `onnxruntime-web` module. Required. */
    ort: unknown;
    modelPath?: string;
    sessionOptions?: Record<string, unknown>;
    /** Inference progress, 0..1, plus the current/total segment counts. */
    onProgress?: (fraction: number, current?: number, total?: number) => void;
    onLog?: (scope: string, message: string) => void;
    /** Bytes received / total while fetching the model. */
    onDownloadProgress?: (loaded: number, total: number) => void;
  }

  export interface SeparatedStems {
    drums: { left: Float32Array; right: Float32Array };
    bass: { left: Float32Array; right: Float32Array };
    other: { left: Float32Array; right: Float32Array };
    vocals: { left: Float32Array; right: Float32Array };
  }

  export class DemucsProcessor {
    constructor(options: DemucsProcessorOptions);
    /** A URL to fetch, or the model bytes already in hand. */
    loadModel(modelPathOrBuffer?: string | ArrayBuffer): Promise<void>;
    /** Separates a whole track; segmentation and overlap-add are internal. */
    separate(left: Float32Array, right: Float32Array): Promise<SeparatedStems>;
  }
}
