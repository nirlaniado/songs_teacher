import { describe, expect, it } from "vitest";
import { alignLyrics, tokenize, type Phrase } from "./lyricSync.js";

const phrase = (start: number, text: string): Phrase => ({ start, end: start + 3, text });

const V1 = ["Hello darkness my old friend", "I've come to talk with you again"];
const CHORUS = ["And the people bowed and prayed", "To the neon god they made"];
const V2 = ["In restless dreams I walked alone", "Narrow streets of cobblestone"];

describe("tokenize", () => {
  it("lowercases, drops punctuation and accents, keeps apostrophes out of words", () => {
    expect(tokenize("I've come — to TALK, café!")).toEqual(["ive", "come", "to", "talk", "cafe"]);
  });
});

describe("alignLyrics", () => {
  const transcript: Phrase[] = [
    phrase(20, "hello darkness my old friend"),
    phrase(24, "I have come to talk with you again"),
    phrase(50, "and the people bowed and prayed"),
    phrase(54, "to the neon god they made"),
    phrase(80, "in restless dreams I walked alone"),
    phrase(84, "narrow streets of cobblestone"),
    phrase(110, "and the people bowed and prade"),
    phrase(114, "to the neon god they made"),
  ];
  const sections = [{ lyrics: V1 }, { lyrics: CHORUS }, { lyrics: V2 }, { lyrics: CHORUS }];

  it("finds where each section starts, tolerating misheard words", () => {
    const m = alignLyrics(transcript, sections);
    expect(m.map((x) => x?.start)).toEqual([20, 50, 80, 110]);
  });

  it("puts a repeated chorus at its own position, not the first one's", () => {
    const m = alignLyrics(transcript, sections);
    expect(m[3]!.start).toBeGreaterThan(m[2]!.start);
  });

  it("reports where each section's singing stops", () => {
    const m = alignLyrics(transcript, sections);
    // Verse 1 ends with its second line (24-27), before the chorus starts at 50.
    expect(m[0]!.end).toBe(27);
    expect(m[2]!.end).toBe(87);
  });

  it("returns null for a section with no lyrics, and matches the others around it", () => {
    const m = alignLyrics(transcript, [{ lyrics: V1 }, { lyrics: [] }, { lyrics: CHORUS }, {}]);
    expect(m[1]).toBeNull();
    expect(m[3]).toBeNull();
    expect(m[0]!.start).toBe(20);
    expect(m[2]!.start).toBe(50);
  });

  it("leaves a section null when nothing in the transcript resembles it", () => {
    const m = alignLyrics(transcript, [{ lyrics: V1 }, { lyrics: ["completely different words that never appear anywhere"] }]);
    expect(m[0]!.start).toBe(20);
    expect(m[1]).toBeNull();
  });

  it("handles an empty transcript and empty sections", () => {
    expect(alignLyrics([], sections)).toEqual([null, null, null, null]);
    expect(alignLyrics(transcript, [])).toEqual([]);
  });

  it("never matches sections out of order", () => {
    const m = alignLyrics(transcript, [{ lyrics: V2 }, { lyrics: V1 }]);
    // V2 (80 s) is found, but V1 only exists before it, so it cannot follow it.
    const starts = m.filter((x) => x !== null).map((x) => x!.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});
