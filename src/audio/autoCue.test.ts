import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "../schema/deck.js";
import { framesFor, type AlignProgress, type RunSession } from "./alignModel.js";
import { cuesForAudio, sectionsOfSlides } from "./autoCue.js";
import { normalizeForVocab, VOCAB } from "./ctcAlign.js";
import * as decode from "./decodeMono.js";
import * as sectionAlign from "./sectionAlign.js";

vi.mock("./decodeMono.js", () => ({ decodeMono: vi.fn() }));
vi.mock("./sectionAlign.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sectionAlign.js")>();
  return { ...actual, alignSections: vi.fn(actual.alignSections) };
});
const decodeMono = vi.mocked(decode.decodeMono);
const alignSections = vi.mocked(sectionAlign.alignSections);

describe("sectionsOfSlides", () => {
  const slide = (name: string, tabText?: string): Slide => ({
    id: crypto.randomUUID(),
    name,
    layout: "blank",
    elements: tabText === undefined ? [] : [
      { id: crypto.randomUUID(), kind: "tab", x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, text: tabText, style: { fontSize: 20, lineHeight: 1.3, valign: "top" } },
    ],
  });

  it("reports each slide's name and how many chord lines it holds", () => {
    expect(sectionsOfSlides([slide("Title"), slide("Verse 1", "G   D\nEm  C"), slide("Empty", "")])).toEqual([
      { name: "Title", lines: 0 },
      { name: "Verse 1", lines: 2 },
      { name: "Empty", lines: 0 },
    ]);
  });
});

describe("cuesForAudio", () => {
  const SECONDS = 25;
  /** C chord for 12 s then F: one clear change in the music at 12 s. */
  function chords(rate: number): Float32Array {
    return Float32Array.from({ length: SECONDS * rate }, (_, i) => {
      const t = i / rate;
      const hz = t < 12 ? [261.63, 329.63, 392] : [349.23, 440, 523.25];
      return hz.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0) / 3;
    });
  }
  // Blobs carry their name; the fake decoder returns a recognisable signal per file and rate.
  const decoded = new Map<string, Float32Array>();
  const fileAt = (name: string, rate: number) => {
    const key = `${name}@${rate}`;
    if (!decoded.has(key)) decoded.set(key, name === "mix" && rate === 22050 ? chords(rate) : new Float32Array(SECONDS * rate).fill(rate / 1e6));
    return decoded.get(key)!;
  };
  const mix = new Blob(["mix"]);
  const vocals = new Blob(["vocals"]);
  const sections = [
    { name: "Verse 1", lines: 4, lyrics: ["Hello darkness, my old friend"] },
    { name: "Chorus", lines: 4, lyrics: ["I've come to talk with you again"] },
  ];

  beforeEach(() => {
    decodeMono.mockReset();
    decodeMono.mockImplementation(async (data, rates) => {
      const name = new TextDecoder().decode(data);
      return rates.map((rate) => fileAt(name, rate));
    });
    alignSections.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A fake wav2vec2 that hears each section's lyrics where `at` says they are sung. */
  function fakeModel(at: number[]): RunSession {
    return async (input) => {
      const frames = framesFor(input.length);
      const token = new Int32Array(frames);
      for (const [k, start] of at.entries()) {
        let f = Math.round(start / 0.02);
        for (const t of normalizeForVocab(sections[k]!.lyrics.join(" "))) {
          token[f++] = (VOCAB as readonly string[]).indexOf(t);
          token[f++] = (VOCAB as readonly string[]).indexOf(t);
          f++;
        }
      }
      const logits = new Float32Array(frames * VOCAB.length);
      for (let j = 0; j < frames; j++)
        for (let v = 0; v < VOCAB.length; v++) logits[j * VOCAB.length + v] = Math.log(v === token[j] ? 0.9 : 0.1 / 31);
      return { logits, frames };
    };
  }

  it("times the sections by aligning their lyrics in the browser, with no network call", async () => {
    const result = await cuesForAudio(mix, sections, { run: fakeModel([2, 12.2]) });
    expect(result.source).toBe("lyrics");
    expect(result.note).toBeUndefined();
    // Verse 1 is sung from 2 s with no change in the music near it; the chorus snaps to the change at 12 s.
    expect(result.times[0]).toBe(2);
    expect(result.times[1]).toBeCloseTo(12, 0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decodes each file once, at both rates, and aligns the vocals stem when there is one", async () => {
    alignSections.mockResolvedValueOnce([{ start: 2, end: 8 }, { start: 12, end: 20 }]);
    await cuesForAudio(mix, sections, { vocals });
    expect(decodeMono).toHaveBeenCalledTimes(2);
    for (const [, rates] of decodeMono.mock.calls) expect(rates).toEqual([22050, 16000]);
    const audio = alignSections.mock.calls[0]![0];
    expect(audio.mix).toBe(fileAt("mix", 16000));
    expect(audio.vocals).toBe(fileAt("vocals", 16000));
  });

  it("aligns the mix when there is no vocals stem", async () => {
    alignSections.mockResolvedValueOnce([{ start: 2, end: 8 }, { start: 12, end: 20 }]);
    await cuesForAudio(mix, sections);
    const audio = alignSections.mock.calls[0]![0];
    expect(audio.mix).toBe(fileAt("mix", 16000));
    expect(audio.vocals).toBeUndefined();
  });

  it("uses the music alone, without decoding for alignment, when there are no lyrics or lyrics are turned off", async () => {
    for (const [s, opts] of [[sections.map(({ lyrics: _, ...rest }) => rest), {}], [sections, { useLyrics: false }]] as const) {
      decodeMono.mockClear();
      const result = await cuesForAudio(mix, s, opts);
      expect(result).toMatchObject({ source: "music" });
      expect(result.note).toBeUndefined();
      expect(decodeMono.mock.calls[0]![1]).toEqual([22050]);
    }
    expect(alignSections).not.toHaveBeenCalled();
  });

  it("falls back to the music with a note when too few sections are found", async () => {
    alignSections.mockResolvedValueOnce([null, null]);
    expect(await cuesForAudio(mix, sections)).toMatchObject({ source: "music", note: "none of the lyrics could be found in the recording" });
    alignSections.mockResolvedValueOnce([{ start: 2, end: 8 }, null]);
    expect(await cuesForAudio(mix, sections)).toMatchObject({ source: "music", note: "too few sections could be found in the recording" });
  });

  it("falls back to the music with the error as the note when alignment fails", async () => {
    alignSections.mockRejectedValueOnce(new Error("Couldn't download the model (503)."));
    expect(await cuesForAudio(mix, sections)).toMatchObject({ source: "music", note: "Couldn't download the model (503)." });
  });

  it("lets cancellation through instead of falling back", async () => {
    alignSections.mockRejectedValueOnce(new DOMException("Analysis cancelled", "AbortError"));
    await expect(cuesForAudio(mix, sections)).rejects.toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    alignSections.mockImplementationOnce(async () => {
      controller.abort();
      return [{ start: 2, end: 8 }, { start: 12, end: 20 }];
    });
    await expect(cuesForAudio(mix, sections, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("shows the first-run model download, never moves backward, and finishes at 1", async () => {
    alignSections.mockImplementationOnce(async (_audio, _sections, opts) => {
      const steps: AlignProgress[] = [
        { stage: "downloading", fraction: 0 },
        { stage: "downloading", fraction: 0.5, detail: "45 / 91 MB" },
        { stage: "downloading", fraction: null },
        { stage: "loading", fraction: null },
        { stage: "inferring", fraction: 0 },
        { stage: "inferring", fraction: 1 },
      ];
      for (const p of steps) opts!.onProgress!(p);
      return [{ start: 2, end: 8 }, { start: 12, end: 20 }];
    });
    const progress = vi.fn();
    await cuesForAudio(mix, sections, { onProgress: progress });
    const fractions = progress.mock.calls.map(([f]) => f as number);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    expect(fractions.at(-1)).toBe(1);
    expect(progress.mock.calls.map(([, d]) => d)).toContain("Downloading the lyric alignment model (first time only) — 45 / 91 MB");
  });
});
