import { describe, expect, it, vi } from "vitest";
import * as ctc from "./ctcAlign.js";
import { framesFor, planChunks, SAMPLES_PER_FRAME, type RunSession } from "./alignModel.js";
import { alignmentBytes, alignSections, MAX_SECTION_TOKENS, WINDOW_SECONDS, WORST_CASE_ALIGNMENT_BYTES } from "./sectionAlign.js";

vi.mock("./ctcAlign.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ctcAlign.js")>();
  return { ...actual, forcedAlign: vi.fn(actual.forcedAlign) };
});
const forcedAlign = vi.mocked(ctc.forcedAlign);

const V = ctc.VOCAB.length;
const RATE = 16_000;
const id = (t: string) => (ctc.VOCAB as readonly string[]).indexOf(t);

/** What the fake model "hears": the token it is sure of at each frame (blank elsewhere) and how sure. */
interface Script { token: Int32Array; p: Float32Array }
function script(seconds: number): Script {
  const frames = framesFor(seconds * RATE);
  return { token: new Int32Array(frames), p: new Float32Array(frames).fill(0.9) };
}
/** Sings `text` from `atSeconds`: each character two frames then a blank. Returns the frame after the last character. */
function sing(s: Script, text: string, atSeconds: number, p = 0.9): number {
  let f = Math.round(atSeconds / 0.02);
  for (const t of ctc.normalizeForVocab(text)) {
    for (let k = 0; k < 2; k++) { s.token[f] = id(t); s.p[f++] = p; }
    s.token[f] = 0; s.p[f++] = 0.9;
  }
  return f - 1;
}
/** A fake session that serves the script's frames for whichever chunk `emissionsFor` asks for, in plan order. */
function session(s: Script, samples: number) {
  const chunks = planChunks(samples);
  const inputs: number[] = [];
  let call = 0;
  const run: RunSession = async (input) => {
    inputs.push(input.length);
    const offset = chunks[call++]!.start / SAMPLES_PER_FRAME;
    const frames = framesFor(input.length);
    const logits = new Float32Array(frames * V);
    for (let j = 0; j < frames; j++) {
      const g = offset + j;
      const p = s.p[g]!;
      for (let v = 0; v < V; v++) logits[j * V + v] = Math.log(v === s.token[g] ? p : (1 - p) / (V - 1));
    }
    return { logits, frames };
  };
  return { run, inputs, calls: () => call };
}
const audio = (seconds: number) => new Float32Array(seconds * RATE).map((_, i) => Math.sin(i * 0.05));

describe("alignSections", () => {
  it("places two sections in order, each starting and ending where it is sung", async () => {
    const s = script(40);
    const end1 = sing(s, "hello darkness my old friend", 5);
    const end2 = sing(s, "i've come to talk with you again", 20);
    const { run } = session(s, 40 * RATE);
    const matches = await alignSections({ mix: audio(40) }, [{ lyrics: ["Hello darkness, my old friend"] }, { lyrics: ["I've come to talk", "with you again"] }], { run });
    expect(matches[0]!.start).toBeCloseTo(5, 1);
    expect(matches[0]!.end).toBeCloseTo(end1 * 0.02, 1);
    expect(matches[1]!.start).toBeCloseTo(20, 1);
    expect(matches[1]!.end).toBeCloseTo(end2 * 0.02, 1);
  });

  it("leaves a section whose lyrics are not sung null, and still places the next one from the last anchor", async () => {
    const s = script(50);
    sing(s, "first verse words here", 3);
    sing(s, "and the chorus comes after", 25);
    const { run } = session(s, 50 * RATE);
    const matches = await alignSections(
      { mix: audio(50) },
      [{ lyrics: ["first verse words here"] }, { lyrics: ["quixotic jazz bequeathed vexing zebras"] }, { lyrics: ["and the chorus comes after"] }],
      { run },
    );
    expect(matches[0]!.start).toBeCloseTo(3, 1);
    expect(matches[1]).toBeNull();
    expect(matches[2]!.start).toBeCloseTo(25, 1);
  });

  it("returns null rather than a time when the model is unsure of the words where they fit", async () => {
    const s = script(30);
    sing(s, "mumbled under the drums", 8, 0.1);
    const { run } = session(s, 30 * RATE);
    expect(await alignSections({ mix: audio(30) }, [{ lyrics: ["mumbled under the drums"] }], { run })).toEqual([null]);
  });

  it("returns null for sections without lyrics without aligning them", async () => {
    const s = script(30);
    sing(s, "only this one sings", 10);
    const { run } = session(s, 30 * RATE);
    forcedAlign.mockClear();
    const matches = await alignSections({ mix: audio(30) }, [{}, { lyrics: [] }, { lyrics: ["only this one sings"] }, { lyrics: ["  ?! "] }], { run });
    expect(matches[0]).toBeNull();
    expect(matches[1]).toBeNull();
    expect(matches[2]!.start).toBeCloseTo(10, 1);
    expect(matches[3]).toBeNull();
    expect(forcedAlign).toHaveBeenCalledTimes(1);
  });

  it("does not run the model at all when no section has lyrics", async () => {
    const { run, calls } = session(script(30), 30 * RATE);
    expect(await alignSections({ mix: audio(30) }, [{}, { lyrics: [] }], { run })).toEqual([null, null]);
    expect(calls()).toBe(0);
  });

  it("aligns the vocals stem instead of the mix when one is given", async () => {
    const s = script(30);
    sing(s, "voice alone", 4);
    const { run, inputs } = session(s, 30 * RATE);
    await alignSections({ mix: audio(31), vocals: audio(30) }, [{ lyrics: ["voice alone"] }], { run });
    expect(inputs).toEqual([30 * RATE]);
  });

  it("places a repeated chorus on its next occurrence each time, not a later one", async () => {
    const s = script(70);
    const chorus = "hold me closer tiny dancer";
    for (const at of [5, 25, 45]) sing(s, chorus, at);
    const { run } = session(s, 70 * RATE);
    const matches = await alignSections({ mix: audio(70) }, [{ lyrics: [chorus] }, { lyrics: [chorus] }, { lyrics: [chorus] }], { run });
    expect(matches.map((m) => m!.start)).toEqual([5, 25, 45]);
  });

  it("does not place wrong lyrics by borrowing the letters they share with what is sung", async () => {
    const s = script(30);
    sing(s, "golf hotel india", 10);
    const { run } = session(s, 30 * RATE);
    expect(await alignSections({ mix: audio(30) }, [{ lyrics: ["hold the line"] }], { run })).toEqual([null]);
  });

  it("takes a repeated chorus's next occurrence even when a letter or two of it is misheard", async () => {
    const s = script(50);
    const chorus = "hold me closer tiny dancer";
    sing(s, chorus, 5);
    // The model hears "closer" as "kloser" and "dancer" as "danser".
    for (const [from, letter] of [[5 + 0.02 * 3 * 8, "K"], [5 + 0.02 * 3 * 24, "S"]] as const) {
      const f = Math.round(from / 0.02);
      s.token[f] = id(letter); s.token[f + 1] = id(letter);
    }
    sing(s, chorus, 25);
    const { run } = session(s, 50 * RATE);
    const [match] = await alignSections({ mix: audio(50) }, [{ lyrics: [chorus] }], { run });
    expect(match!.start).toBe(5);
  });

  it("does not place short lyrics on letters scattered through other words", async () => {
    // H and I are both sung, in order (inside "tHe quIck"), but not as the word "hi".
    const s = script(30);
    sing(s, "the quick brown fox", 10);
    const { run } = session(s, 30 * RATE);
    expect(await alignSections({ mix: audio(30) }, [{ lyrics: ["hi"] }], { run })).toEqual([null]);
  });

  it("does not let a section stretch over the singing that follows it", async () => {
    const s = script(30);
    const end = sing(s, "short line", 2);
    sing(s, "a much longer line of other words that follows straight after", end * 0.02 + 0.5);
    const { run } = session(s, 30 * RATE);
    const [match] = await alignSections({ mix: audio(30) }, [{ lyrics: ["short line"] }], { run });
    expect(match!.end).toBeCloseTo(end * 0.02, 1);
  });

  it("never runs backwards, even when sections are listed in a different order than they are sung", async () => {
    const s = script(60);
    sing(s, "alpha bravo charlie", 30);
    sing(s, "delta echo foxtrot", 10);
    sing(s, "golf hotel india", 45);
    const { run } = session(s, 60 * RATE);
    const matches = await alignSections({ mix: audio(60) }, [{ lyrics: ["alpha bravo charlie"] }, { lyrics: ["delta echo foxtrot"] }, { lyrics: ["golf hotel india"] }], { run });
    expect(matches[0]!.start).toBeCloseTo(30, 1);
    expect(matches[1]).toBeNull();
    expect(matches[2]!.start).toBeCloseTo(45, 1);
    const placed = matches.filter((m) => m !== null);
    for (let i = 1; i < placed.length; i++) expect(placed[i]!.start).toBeGreaterThanOrEqual(placed[i - 1]!.end);
  });
});

describe("alignment memory", () => {
  it("bounds the worst case to one window against the token cap, under 10 MB", () => {
    expect(WORST_CASE_ALIGNMENT_BYTES).toBe(alignmentBytes((WINDOW_SECONDS / 0.02), MAX_SECTION_TOKENS));
    expect(WORST_CASE_ALIGNMENT_BYTES).toBeLessThan(10 * 1024 * 1024);
    // The whole-song trellis this replaces, for the same six dense minutes.
    expect(alignmentBytes(18_000, 3000)).toBeGreaterThan(100 * 1024 * 1024);
  });

  it("keeps every alignment of a six-minute song with dense lyrics within the bound", async () => {
    const s = script(360);
    const line = "we sing these words so fast the frames can barely hold them all ";
    const sections = Array.from({ length: 12 }, (_, k) => ({ lyrics: [`${line.repeat(6)}part ${k}`] }));
    for (const [k, section] of sections.entries()) sing(s, section.lyrics[0]!, 2 + k * 29.5);
    const { run } = session(s, 360 * RATE);
    forcedAlign.mockClear();
    const tooLong = { lyrics: ["la ".repeat(MAX_SECTION_TOKENS)] };
    const matches = await alignSections({ mix: audio(360) }, [...sections, tooLong], { run });

    expect(matches.slice(0, 12).every((m) => m !== null)).toBe(true);
    expect(matches[12]).toBeNull();
    expect(forcedAlign).toHaveBeenCalledTimes(12);
    for (const [rows, ids] of forcedAlign.mock.calls) {
      expect(rows.length).toBeLessThanOrEqual(WINDOW_SECONDS / 0.02);
      expect(ids.length).toBeLessThanOrEqual(MAX_SECTION_TOKENS);
      expect(alignmentBytes(rows.length, ids.length)).toBeLessThanOrEqual(WORST_CASE_ALIGNMENT_BYTES);
    }
  });
});
