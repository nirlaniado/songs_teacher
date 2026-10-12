import { describe, expect, it, vi } from "vitest";
import { VOCAB } from "./ctcAlign.js";
import { SAMPLES_PER_FRAME, emissionsFor, framesFor, normalize, onnxSession, planChunks, type RunSession } from "./alignModel.js";

const ort = vi.hoisted(() => ({
  inputNames: ["input_values"], outputNames: ["logits"],
  run: vi.fn(), tensors: [] as unknown[][],
}));
vi.mock("onnxruntime-web", () => ({
  InferenceSession: { create: vi.fn(async () => ({ inputNames: ort.inputNames, outputNames: ort.outputNames, run: ort.run })) },
  Tensor: class { constructor(...args: unknown[]) { ort.tensors.push(args); } },
}));
vi.mock("./modelCache.js", () => ({ loadModelBytes: vi.fn(async () => new ArrayBuffer(8)) }));

const V = VOCAB.length;
const SECONDS = 16_000;
const CHUNK = 30 * SECONDS;

/** Fake session: call k fills column 0 of local frame j with k*10000 + j, and column v with v. */
function stamping() {
  let calls = 0;
  const inputs: Float32Array[] = [];
  const run: RunSession = async input => {
    const k = calls++;
    inputs.push(input.slice());
    const frames = framesFor(input.length);
    const logits = new Float32Array(frames * V);
    for (let j = 0; j < frames; j++) for (let v = 0; v < V; v++) logits[j * V + v] = v === 0 ? k * 10_000 + j : v;
    return { logits, frames };
  };
  return { run, inputs, calls: () => calls };
}
const noise = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * 0.3 + Math.sin(i * 0.011) * 0.5 + 0.1);

describe("framesFor", () => {
  it("matches the conv stack's 400-sample receptive field and 320-sample stride", () => {
    for (const n of [0, 399, 400, 719, 720, 721, 16_000, CHUNK, CHUNK + 1, 2 * CHUNK + 123, 3_840_000])
      expect(framesFor(n)).toBe(n < 400 ? 0 : Math.floor((n - 400) / 320) + 1);
  });
});

describe("planChunks", () => {
  it("covers the waveform with frame-aligned, overlapping chunks and a short final chunk", () => {
    for (const n of [70 * SECONDS, 2 * CHUNK, 2 * CHUNK + 123, 241 * SECONDS + 7]) {
      const chunks = planChunks(n);
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.start + chunks.at(-1)!.length).toBe(n);
      for (const c of chunks) {
        expect(c.start % SAMPLES_PER_FRAME).toBe(0);
        expect(c.length).toBeLessThanOrEqual(CHUNK);
      }
      for (let i = 1; i < chunks.length; i++) {
        const [a, b] = [chunks[i - 1]!, chunks[i]!];
        expect(a.start + a.length - b.start).toBe(4 * SECONDS);
        expect(b.keepFrom).toBe(a.keepTo);
        expect(b.keepFrom - b.start / SAMPLES_PER_FRAME).toBe(100);
        expect(a.start / SAMPLES_PER_FRAME + framesFor(a.length) - a.keepTo).toBeGreaterThanOrEqual(99);
      }
      expect(chunks[0]!.keepFrom).toBe(0);
      expect(chunks.at(-1)!.keepTo).toBe(framesFor(n));
    }
  });
  it("plans one chunk for a song no longer than a chunk, and none for under one frame", () => {
    expect(planChunks(CHUNK)).toEqual([{ start: 0, length: CHUNK, keepFrom: 0, keepTo: framesFor(CHUNK) }]);
    expect(planChunks(399)).toEqual([]);
  });
});

describe("normalize", () => {
  it("gives zero mean and unit variance", () => {
    const out = normalize(noise(50_000));
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const variance = out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length;
    expect(mean).toBeCloseTo(0, 5);
    expect(variance).toBeCloseTo(1, 3);
  });
  it("maps a constant signal to zeros instead of dividing by zero", () => {
    const out = normalize(new Float32Array(1000).fill(0.4));
    expect(out.every(x => x === 0)).toBe(true);
  });
});

describe("emissionsFor", () => {
  it("stitches each frame from the chunk that owns it, at the instant it was produced for", async () => {
    const n = 70 * SECONDS;
    const fake = stamping();
    const e = await emissionsFor(noise(n), undefined, fake.run);
    expect(fake.calls()).toBe(3);
    expect(e.frames).toBe(framesFor(n));
    expect(e.logits.length).toBe(e.frames * V);
    const at = (g: number) => { const v = e.logits[g * V]!; return { chunk: Math.floor(v / 10_000), local: v % 10_000 }; };
    // Seams fall 100 frames past each later chunk's start (frames 1300 and 2600).
    expect(at(1399)).toEqual({ chunk: 0, local: 1399 });
    expect(at(1400)).toEqual({ chunk: 1, local: 100 });
    expect(at(2699)).toEqual({ chunk: 1, local: 1399 });
    expect(at(2700)).toEqual({ chunk: 2, local: 100 });
    for (let g = 0; g < e.frames; g++) {
      const { chunk, local } = at(g);
      expect(chunk * 1300 + local).toBe(g);
      expect(e.logits[g * V + 31]).toBe(31);
    }
  });

  it("produces exactly the frames the waveform implies, divisible by the chunk size or not", async () => {
    for (const n of [2 * CHUNK, 2 * CHUNK + 123, 3 * CHUNK - 1, 241 * SECONDS + 7]) {
      const e = await emissionsFor(noise(n), undefined, stamping().run);
      expect(e.frames).toBe(Math.floor((n - 400) / 320) + 1);
      expect(e.logits.length).toBe(e.frames * V);
      for (let g = 0; g < e.frames; g++) expect(e.logits[g * V + 1]).toBe(1);
    }
  });

  it("treats a song shorter than a chunk as one unchunked pass over the normalised waveform", async () => {
    const samples = noise(20 * SECONDS);
    const fake = stamping();
    const e = await emissionsFor(samples, undefined, fake.run);
    expect(fake.calls()).toBe(1);
    expect(fake.inputs[0]).toEqual(normalize(samples));
    expect(e.logits).toEqual((await stamping().run(normalize(samples))).logits);
    expect(e.secondsPerFrame).toBe(0.02);
  });

  it("returns zero frames for input under one frame without running the model", async () => {
    for (const n of [0, 399]) {
      const fake = stamping();
      expect(await emissionsFor(new Float32Array(n), undefined, fake.run)).toEqual({ logits: new Float32Array(0), frames: 0, vocabSize: V, secondsPerFrame: 0.02 });
      expect(fake.calls()).toBe(0);
    }
    expect((await emissionsFor(new Float32Array(400), undefined, stamping().run)).frames).toBe(1);
  });

  it("rejects a session that returns a different frame count than the waveform implies", async () => {
    const run: RunSession = async input => ({ logits: new Float32Array((framesFor(input.length) - 1) * V), frames: framesFor(input.length) - 1 });
    await expect(emissionsFor(noise(SECONDS), undefined, run)).rejects.toThrow(/expected 49/);
  });

  it("reports inference progress per chunk", async () => {
    const progress = vi.fn();
    await emissionsFor(noise(70 * SECONDS), progress, stamping().run);
    expect(progress.mock.calls.map(([p]) => p.fraction)).toEqual([0, 1 / 3, 2 / 3, 1]);
  });
});

describe("onnxSession", () => {
  it("feeds input_values and reads logits", async () => {
    ort.run.mockResolvedValue({ logits: { data: new Float32Array(2 * V), dims: [1, 2, V] } });
    const out = await onnxSession()(new Float32Array(720));
    expect(out.frames).toBe(2);
    expect(Object.keys(ort.run.mock.calls[0]![0])).toEqual(["input_values"]);
    expect(ort.tensors.at(-1)).toEqual(["float32", expect.any(Float32Array), [1, 720]]);
  });
  it("fails clearly before inference when the model's tensor names differ", async () => {
    ort.run.mockClear();
    ort.inputNames = ["input"]; ort.outputNames = ["output"];
    await expect(onnxSession()(new Float32Array(720))).rejects.toThrow(/inputs \[input\] and outputs \[output\]; expected "input_values" → "logits"/);
    expect(ort.run).not.toHaveBeenCalled();
    ort.inputNames = ["input_values"]; ort.outputNames = ["logits"];
  });
});
