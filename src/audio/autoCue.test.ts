import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "../schema/deck.js";
import { framesFor, type RunSession } from "./alignModel.js";
import { cuesForAudio, sectionsOfSlides } from "./autoCue.js";
import { normalizeForVocab, VOCAB } from "./ctcAlign.js";
import * as decode from "./decodeMono.js";
import * as sectionAlign from "./sectionAlign.js";
import { applyLayout } from "../deck/templates.js";
import { chordDeckSlides } from "../deck/fromChords.js";

vi.mock("./decodeMono.js", () => ({ decodeMono: vi.fn() }));
// The real loader and session code run; only ONNX Runtime itself is replaced, by a model that hears nothing but blank.
const ortRun = vi.hoisted(() => vi.fn());
vi.mock("onnxruntime-web", () => ({
  InferenceSession: { create: vi.fn(async () => ({ inputNames: ["input_values"], outputNames: ["logits"], run: ortRun })) },
  Tensor: class { dims: number[]; constructor(_type: string, _data: unknown, dims: number[]) { this.dims = dims; } },
}));
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

  const newId = () => crypto.randomUUID();
  /** A slide built from a real layout, its title and body placeholders filled in order, plus any extra elements. */
  function laidOut(name: string, layout: Slide["layout"], title: string, bodies: string[], extra: Slide["elements"] = []): Slide {
    let b = 0;
    const elements = applyLayout([], layout, newId).map((el) =>
      el.kind !== "text" ? el : { ...el, text: el.role === "title" ? title : (bodies[b++] ?? "") },
    );
    return { id: newId(), name, layout, elements: [...elements, ...extra] };
  }
  const tab = (text: string): Slide["elements"][number] => ({
    id: newId(), kind: "tab", x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, text, style: { fontSize: 20, lineHeight: 1.3, valign: "top" },
  });
  const note = (text: string): Slide["elements"][number] => ({
    id: newId(), kind: "text", x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, text, role: "none",
    style: { fontSize: 20, bold: false, italic: false, underline: false, align: "left", valign: "top", lineHeight: 1.25 },
  });

  it("takes lyrics from body placeholders only — never the heading, the cover, a tab or a free text box", () => {
    const sections = sectionsOfSlides([
      laidOut("Title", "centered", "The Sound of Silence", ["Simon & Garfunkel\nKey: Dm · Tuning: E A D G B E"]),
      laidOut("Verse 1", "titleContent", "Verse 1", ["Hello darkness, my old friend\n\n  I've come to talk with you again  "], [tab("Dm   C\nDm")]),
      laidOut("Chorus", "titleTwoContent", "Chorus", ["And the vision", "Still remains"], [note("Watch the bend here")]),
    ]);
    expect(sections).toEqual([
      { name: "Title", lines: 0 },
      { name: "Verse 1", lines: 2, lyrics: ["Hello darkness, my old friend", "I've come to talk with you again"] },
      { name: "Chorus", lines: 0, lyrics: ["And the vision", "Still remains"] },
    ]);
    const all = sections.flatMap((s) => s.lyrics ?? []).join("\n");
    for (const leak of ["Verse 1", "Chorus", "Sound of Silence", "Simon", "Key", "Tuning", "Dm", "bend"]) expect(all).not.toContain(leak);
  });

  it("judges the cover by its content, not its layout, so switching layouts doesn't change what counts as a lyric", () => {
    const cover = laidOut("Title", "titleContent", "The Sound of Silence", ["Simon & Garfunkel\nKey: Dm"]);
    const verse = laidOut("Verse 1", "titleContent", "Verse 1", ["Hello darkness, my old friend"], [tab("Dm   C")]);
    const chorus = laidOut("Chorus", "centered", "Chorus", ["And the vision"], [tab("F   C")]);
    expect(sectionsOfSlides([cover, verse, chorus])).toEqual([
      { name: "Title", lines: 0 },
      { name: "Verse 1", lines: 1, lyrics: ["Hello darkness, my old friend"] },
      { name: "Chorus", lines: 1, lyrics: ["And the vision"] },
    ]);
  });

  it("finds no lyrics in a chord-import deck, whose lyrics live inside the tab element beside the chords", () => {
    const slides = chordDeckSlides({
      source: { id: "1", title: "Hallelujah", artist: "Leonard Cohen", url: "https://example.com", official: true, version: 1, views: 1 },
      retrievedAt: "2026-01-01T00:00:00.000Z", selection: "official", warning: null, capo: 5, tuning: "E A D G B E", key: "C",
      lines: [
        { section: "Verse 1", sourceLine: 0, chords: ["C", "Am"], row: "C   Am", lyric: "I heard there was a secret chord" },
        { section: "Chorus", sourceLine: 1, chords: ["F", "Am"], row: "F   Am", lyric: "Hallelujah" },
      ],
      uniqueChords: ["C", "Am", "F"], chart: "",
    }, newId);
    expect(sectionsOfSlides(slides)).toEqual([
      { name: "Title", lines: 0 },
      { name: "Verse 1", lines: 2 },
      { name: "Chorus", lines: 2 },
    ]);
  });

  it("handles a slide with no text, a lone slide and an empty deck", () => {
    expect(sectionsOfSlides([])).toEqual([]);
    expect(sectionsOfSlides([laidOut("Blank", "titleContent", "", [""])])).toEqual([{ name: "Blank", lines: 0 }]);
    expect(sectionsOfSlides([laidOut("Only", "contentOnly", "", ["Just one line"])])).toEqual([
      { name: "Only", lines: 0, lyrics: ["Just one line"] },
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
    ortRun.mockReset();
    ortRun.mockImplementation(async (feeds: Record<string, { dims: number[] }>) => {
      const frames = framesFor(feeds.input_values!.dims[1]!);
      const data = new Float32Array(frames * VOCAB.length).fill(Math.log(0.1 / 31));
      for (let j = 0; j < frames; j++) data[j * VOCAB.length] = Math.log(0.9);
      return { logits: { data, dims: [1, frames, VOCAB.length] } };
    });
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

  it("takes the lyrics path for a deck whose slides carry lyrics, and the music alone for one that doesn't", async () => {
    const slide = (name: string, body: string): Slide => ({
      id: crypto.randomUUID(), name, layout: "titleContent",
      elements: applyLayout([], "titleContent", () => crypto.randomUUID()).map((el) =>
        el.kind === "text" ? { ...el, text: el.role === "title" ? name : body } : el),
    });
    alignSections.mockResolvedValueOnce([{ start: 2, end: 8 }, { start: 12, end: 20 }]);
    const sung = await cuesForAudio(mix, sectionsOfSlides([slide("Verse 1", sections[0]!.lyrics[0]!), slide("Chorus", sections[1]!.lyrics[0]!)]));
    expect(sung.source).toBe("lyrics");
    expect(alignSections.mock.calls[0]![1].map((s) => s.lyrics)).toEqual(sections.map((s) => s.lyrics));

    alignSections.mockClear();
    const unsung = await cuesForAudio(mix, sectionsOfSlides([slide("Verse 1", ""), slide("Chorus", "")]));
    expect(unsung).toMatchObject({ source: "music" });
    expect(unsung.note).toBeUndefined();
    expect(alignSections).not.toHaveBeenCalled();
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

  it("falls back to the music when the 16 kHz copy for alignment can't be made", async () => {
    decodeMono.mockImplementation(async (data, rates) => {
      const name = new TextDecoder().decode(data);
      return rates.map((rate) => (rate === 16000 ? new Error("OfflineAudioContext failed") : fileAt(name, rate)));
    });
    expect(await cuesForAudio(mix, sections)).toMatchObject({ source: "music", note: "OfflineAudioContext failed" });
    expect(alignSections).not.toHaveBeenCalled();
  });

  /** The model download, served by a stub whose chunks arrive when the test says, and which errors on abort like fetch. */
  function modelDownload(chunks: number, contentLength?: string | null) {
    const size = 1_000_000;
    const releases: Array<() => void> = [];
    const gates = Array.from({ length: chunks }, () => new Promise<void>((resolve) => releases.push(resolve)));
    const state = { signal: undefined as AbortSignal | undefined, aborted: false };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      state.signal = init?.signal ?? undefined;
      let i = 0;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          state.signal?.addEventListener("abort", () => { state.aborted = true; controller.error(new DOMException("aborted", "AbortError")); });
        },
        async pull(controller) {
          if (i === chunks) return controller.close();
          await gates[i++];
          if (!state.aborted) controller.enqueue(new Uint8Array(size));
        },
      }), { headers: contentLength === null ? {} : { "Content-Length": contentLength ?? String(chunks * size) } });
    }));
    return { state, release: (i: number) => releases[i]!() };
  }

  it("shows the model downloading as its bytes arrive, then loading and listening, never moving backward", async () => {
    // A Cache API whose put reads the whole body first, as the browser's does.
    const stored = new Map<string, ArrayBuffer>();
    vi.stubGlobal("caches", { open: async () => ({ match: async () => undefined, put: async (url: string, r: Response) => { stored.set(url, await r.arrayBuffer()); } }) });
    const download = modelDownload(3);
    const progress: Array<[number, string | undefined]> = [];
    const done = cuesForAudio(mix, sections, { onProgress: (f, d) => progress.push([f, d]) });
    // While later chunks are still held back, each arrived chunk is the newest thing on the bar.
    for (let i = 0; i < 2; i++) {
      download.release(i);
      await vi.waitFor(() => expect(progress.at(-1)).toEqual([0.5 + 0.25 * ((i + 1) / 3), `Downloading the lyric alignment model (first time only) — ${i + 1} / 3 MB`]), { timeout: 10_000 });
    }
    download.release(2);
    // A model that hears nothing finds no lyrics, so this ends on the music.
    expect(await done).toMatchObject({ source: "music" });
    const stages = progress.map(([, d]) => d?.replace(/ —.*/, "")).filter((d, i, all) => i === 0 || d !== all[i - 1]);
    expect(stages).toEqual([undefined, "Downloading the lyric alignment model (first time only)", "Loading the lyric alignment model", "Listening for the lyrics", undefined]);
    for (let i = 1; i < progress.length; i++) expect(progress[i]![0]).toBeGreaterThanOrEqual(progress[i - 1]![0]);
    expect(progress.at(-1)![0]).toBe(1);
    expect(stored.size).toBe(1);
  });

  it("shows a download of unknown size as received megabytes with the bar held, and an understated one capped at its end", async () => {
    for (const [length, labels] of [[null, ["1 MB", "2 MB", "3 MB"]], ["1000000", ["1 / 1 MB", "2 / 2 MB", "3 / 3 MB"]]] as const) {
      const download = modelDownload(3, length);
      const progress: Array<[number, string | undefined]> = [];
      const done = cuesForAudio(mix, sections, { onProgress: (f, d) => progress.push([f, d]) });
      for (let i = 0; i < 3; i++) download.release(i);
      await done;
      const downloads = progress.filter(([, d]) => d?.startsWith("Downloading"));
      expect(downloads.slice(1).map(([, d]) => d!.replace(/.*— /, ""))).toEqual(labels);
      for (const [f] of downloads) expect(f).toBeLessThanOrEqual(0.75);
      if (length === null) for (const [f] of downloads) expect(f).toBe(0.5);
    }
  });

  it("cancels the model download itself when cancelled during it", async () => {
    const download = modelDownload(3);
    const controller = new AbortController();
    const progress = vi.fn();
    const done = cuesForAudio(mix, sections, { signal: controller.signal, onProgress: progress });
    download.release(0);
    await vi.waitFor(() => expect(progress.mock.calls.some(([, d]) => /1 \/ 3 MB/.test(d ?? ""))).toBe(true), { timeout: 10_000 });

    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(download.state.signal).toBe(controller.signal);
    expect(download.state.aborted).toBe(true);
    expect(ortRun).not.toHaveBeenCalled();
  });

  it("stops waiting on inference when cancelled during it, and starts no further chunk", async () => {
    const controller = new AbortController();
    const run = vi.fn<RunSession>(() => new Promise(() => {}));
    const done = cuesForAudio(mix, sections, { signal: controller.signal, run });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets an AbortError from alignment through instead of falling back", async () => {
    alignSections.mockRejectedValueOnce(new DOMException("Analysis cancelled", "AbortError"));
    await expect(cuesForAudio(mix, sections)).rejects.toMatchObject({ name: "AbortError" });
  });
});
