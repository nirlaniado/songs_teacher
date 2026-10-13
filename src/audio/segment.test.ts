import { describe, expect, it } from "vitest";
import { analyse, chooseBoundaries, firstOnset, planCues, planFromMatches, snapToNovelty, TITLE_HOLD_SECONDS, type Analysis } from "./segment.js";

const RATE = 22050;

const CHORDS = {
  C: [261.63, 329.63, 392.0],
  F: [349.23, 440.0, 523.25],
  G: [392.0, 493.88, 587.33],
} as const;

/** Each entry is one chord held for `seconds` — a stand-in for a song section. */
function song(parts: Array<[keyof typeof CHORDS, number]>): Float32Array {
  const total = parts.reduce((sum, [, s]) => sum + s, 0);
  const out = new Float32Array(Math.round(total * RATE));
  let offset = 0;
  for (const [name, seconds] of parts) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const hz of CHORDS[name]) v += Math.sin((2 * Math.PI * hz * (offset + i)) / RATE);
      out[offset + i] = v / 3;
    }
    offset += n;
  }
  return out;
}

const CHART = { title: { name: "Title", lines: 0 }, sec: (name: string, lines = 4) => ({ name, lines }) };

describe("planCues", () => {
  it("does not let the cover slide use up the intro's change — every part lands on its own", async () => {
    // Intro 0-12 s (C), verse 12-24 s (F), chorus 24-36 s (G).
    const analysis = await analyse(song([["C", 12], ["F", 12], ["G", 12]]), RATE);
    const cues = planCues(analysis, [CHART.title, CHART.sec("Intro", 1), CHART.sec("Verse 1"), CHART.sec("Chorus")]);
    expect(cues[0]).toBe(0);
    expect(cues[1]).toBe(TITLE_HOLD_SECONDS); // Intro takes over from the cover shortly after the start
    expect(Math.abs(cues[2]! - 12)).toBeLessThan(1.5); // Verse 1 where the verse really starts
    expect(Math.abs(cues[3]! - 24)).toBeLessThan(1.5);
  });

  it("keeps a chart that opens on a verse under the cover during the instrumental intro", async () => {
    const analysis = await analyse(song([["C", 12], ["F", 12], ["G", 12]]), RATE);
    const cues = planCues(analysis, [CHART.title, CHART.sec("Verse 1"), CHART.sec("Chorus")]);
    expect(cues[0]).toBe(0);
    expect(Math.abs(cues[1]! - 12)).toBeLessThan(1.5);
    expect(Math.abs(cues[2]! - 24)).toBeLessThan(1.5);
  });

  it("starts a verse-first chart right away when the vocals show singing from the start", async () => {
    const analysis = await analyse(song([["C", 12], ["F", 12], ["G", 12]]), RATE);
    const cues = planCues(analysis, [CHART.title, CHART.sec("Verse 1"), CHART.sec("Chorus")], { vocalsOnset: 1 });
    expect(cues[1]).toBe(TITLE_HOLD_SECONDS);
    expect(cues[2]).toBeDefined();
  });

  it("treats a deck with no cover slide as starting at 0:00", async () => {
    const analysis = await analyse(song([["C", 12], ["F", 12], ["G", 12]]), RATE);
    const cues = planCues(analysis, [CHART.sec("A", 2), CHART.sec("B", 2), CHART.sec("C", 2)]);
    expect(cues[0]).toBe(0);
    expect(Math.abs(cues[1]! - 12)).toBeLessThan(1.5);
    expect(Math.abs(cues[2]! - 24)).toBeLessThan(1.5);
  });

  it("always runs forward", async () => {
    const analysis = await analyse(song([["C", 12], ["F", 12], ["G", 12], ["C", 12]]), RATE);
    const cues = planCues(analysis, [CHART.title, CHART.sec("Intro", 1), CHART.sec("Verse 1"), CHART.sec("Chorus"), CHART.sec("Verse 2")]);
    const set = cues.filter((c): c is number => c !== undefined);
    for (let i = 1; i < set.length; i++) expect(set[i]!).toBeGreaterThanOrEqual(set[i - 1]!);
  });

  it("leaves slides uncued rather than inventing changes the audio doesn't have", async () => {
    const analysis = await analyse(song([["C", 30]]), RATE);
    const cues = planCues(analysis, [CHART.title, CHART.sec("Intro", 1), CHART.sec("Verse 1"), CHART.sec("Chorus")]);
    expect(cues).toEqual([0, TITLE_HOLD_SECONDS, undefined, undefined]);
  });

  it("handles zero and one slide", () => {
    const analysis: Analysis = { novelty: [], blockSeconds: 0.46, rate: RATE };
    expect(planCues(analysis, [])).toEqual([]);
    expect(planCues(analysis, [CHART.title])).toEqual([0]);
  });
});

describe("chooseBoundaries", () => {
  // One second per block; only these blocks have any change at all.
  const analysis = (spikes: Record<number, number>): Analysis => ({
    blockSeconds: 1,
    rate: RATE,
    novelty: Array.from({ length: 60 }, (_, i) => spikes[i] ?? 0),
  });

  it("prefers a change that keeps sections in proportion over a slightly stronger one that doesn't", () => {
    // Two equal-length sections in a 60 s song: the split belongs near the middle,
    // not at the marginally louder change 14 s in.
    expect(chooseBoundaries(analysis({ 14: 1, 40: 0.9 }), 1, [1, 1], 6)).toEqual([40]);
  });

  it("does not use a change that would make a section shorter than the minimum", () => {
    expect(chooseBoundaries(analysis({ 20: 1, 23: 1 }), 2, [1, 1, 1], 6)).toHaveLength(1);
  });

  it("returns nothing when the audio has no change at all", () => {
    expect(chooseBoundaries(analysis({}), 2, [1, 1, 1], 6)).toEqual([]);
  });

  it("returns as many as it can when there are fewer usable changes than asked for", () => {
    expect(chooseBoundaries(analysis({ 20: 1 }), 3, [1, 1, 1, 1], 6)).toEqual([20]);
  });
});

describe("planFromMatches", () => {
  // One second per block, real changes at 10, 30, 52 and 80 s.
  const analysis: Analysis = {
    blockSeconds: 1,
    rate: RATE,
    novelty: Array.from({ length: 100 }, (_, i) => ({ 10: 5, 30: 5, 52: 5, 80: 5 } as Record<number, number>)[i] ?? 0),
  };
  const sec = (name: string, lyrics: string[] = ["some words here"], lines = 4) => ({ name, lines, lyrics });
  const title = { name: "Title", lines: 0, lyrics: [] };

  it("starts each section where its lyrics were found, snapped to the change in the music", () => {
    const sections = [title, sec("Verse 1"), sec("Chorus")];
    // The lyrics are found a little late (11.2 and 31.4); the music changes at 10 and 30.
    const cues = planFromMatches(analysis, sections, [null, { start: 11.2, end: 20 }, { start: 31.4, end: 45 }]);
    expect(cues).toEqual([0, 10, 30]);
  });

  it("gives an opening Intro the title hold, so it never takes the time of the section after it", () => {
    const sections = [title, sec("Intro", [], 1), sec("Verse 1"), sec("Chorus")];
    const cues = planFromMatches(analysis, sections, [null, null, { start: 10.5, end: 25 }, { start: 30.5, end: 45 }]);
    expect(cues).toEqual([0, TITLE_HOLD_SECONDS, 10, 30]);
  });

  it("starts an instrumental section where the singing before it ends", () => {
    const sections = [title, sec("Verse 1"), sec("Solo", [], 2), sec("Chorus")];
    // Verse 1 is sung 10-24 s; the chorus starts at 52 s; the solo fills the gap.
    const cues = planFromMatches(analysis, sections, [null, { start: 10, end: 24 }, null, { start: 52, end: 70 }]);
    expect(cues![1]).toBe(10);
    expect(cues![2]).toBe(24);
    expect(cues![3]).toBe(52);
  });

  it("starts a trailing outro after the last singing", () => {
    const sections = [title, sec("Verse 1"), sec("Chorus"), sec("Outro", [], 1)];
    const cues = planFromMatches(analysis, sections, [null, { start: 10, end: 24 }, { start: 30, end: 60 }, null]);
    expect(cues![3]).toBe(60);
  });

  it("returns null when too few sections were found to trust", () => {
    const sections = [title, sec("Verse 1"), sec("Chorus"), sec("Verse 2"), sec("Bridge")];
    expect(planFromMatches(analysis, sections, [null, { start: 10, end: 20 }, null, null, null])).toBeNull();
  });

  it("never lets cues run backwards", () => {
    const sections = [title, sec("A"), sec("B"), sec("C")];
    const cues = planFromMatches(analysis, sections, [null, { start: 52, end: 60 }, { start: 30, end: 40 }, { start: 80, end: 90 }])!;
    const set = cues.filter((c): c is number => c !== undefined);
    for (let i = 1; i < set.length; i++) expect(set[i]!).toBeGreaterThanOrEqual(set[i - 1]!);
  });
});

describe("snapToNovelty", () => {
  const analysis: Analysis = { blockSeconds: 1, rate: RATE, novelty: Array.from({ length: 60 }, (_, i) => (i === 20 ? 5 : 0)) };

  it("moves a time onto a nearby change", () => {
    expect(snapToNovelty([21.6], analysis, 2.5)).toEqual([20]);
  });

  it("leaves a time alone when no change is near it", () => {
    expect(snapToNovelty([40], analysis, 2.5)).toEqual([40]);
  });
});

describe("firstOnset", () => {
  it("finds where sound starts", () => {
    const s = new Float32Array(RATE * 5);
    for (let i = 2 * RATE; i < s.length; i++) s[i] = Math.sin((2 * Math.PI * 200 * i) / RATE);
    expect(Math.abs(firstOnset(s, RATE)! - 2)).toBeLessThan(0.1);
  });

  it("is null for silence", () => {
    expect(firstOnset(new Float32Array(RATE), RATE)).toBeNull();
  });
});

describe("no two cues on one instant", () => {
  const spikes = (blockSeconds: number, length: number, at: Record<number, number>): Analysis => ({
    blockSeconds, rate: RATE, novelty: Array.from({ length }, (_, i) => at[i] ?? 0),
  });
  const strictlyIncreasing = (times: Array<number | undefined>) => {
    const set = times.filter((t): t is number => t !== undefined);
    for (let i = 1; i < set.length; i++) expect(set[i]!).toBeGreaterThan(set[i - 1]!);
  };

  it("planCues: leaves the sections uncued when their change rounds onto the cover's 0:00", () => {
    // The only change is at 0.04 s, which rounds to 0 — the cover's time.
    const cues = planCues(spikes(0.01, 100, { 4: 5 }), [CHART.title, CHART.sec("Intro"), CHART.sec("Verse 1")], { minGapSeconds: 0 });
    expect(cues).toEqual([0, undefined, undefined]);
  });

  it("planCues: two changes that round to the same tenth cue only the first slide", () => {
    const cues = planCues(spikes(0.01, 300, { 101: 5, 104: 5 }), [CHART.sec("A"), CHART.sec("B"), CHART.sec("C")], { minGapSeconds: 0 });
    expect(cues).toEqual([0, 1, undefined]);
  });

  describe("planFromMatches", () => {
    const sec = (name: string, lyrics: string[] = ["words"], lines = 4) => ({ name, lines, lyrics });
    const title = { name: "Title", lines: 0, lyrics: [] };

    it("leaves a section uncued when its anchor snaps onto the cover's 0", () => {
      const analysis = spikes(1, 100, { 0: 5, 30: 5 });
      const cues = planFromMatches(analysis, [title, sec("Verse 1"), sec("Chorus")], [null, { start: 0.4, end: 20 }, { start: 30.5, end: 45 }]);
      expect(cues).toEqual([0, undefined, 30]);
    });

    it("leaves the later section uncued when two anchors snap onto the same change", () => {
      const analysis = spikes(1, 100, { 30: 5, 60: 5 });
      const cues = planFromMatches(analysis, [title, sec("A"), sec("B"), sec("C")], [null, { start: 29, end: 31 }, { start: 31.5, end: 40 }, { start: 60, end: 70 }]);
      expect(cues).toEqual([0, 30, undefined, 60]);
    });

    it("leaves an instrumental section uncued rather than on the anchor it would share a time with", () => {
      // Verse 1's singing "ends" where it starts, so the solo would begin on the verse's own cue.
      const analysis = spikes(1, 100, { 10: 5, 52: 5 });
      const cues = planFromMatches(analysis, [title, sec("Verse 1"), sec("Solo", [], 2), sec("Chorus")], [null, { start: 10, end: 10 }, null, { start: 52, end: 70 }]);
      expect(cues).toEqual([0, 10, undefined, 52]);
    });
  });

  it("never returns equal or backward times, and keeps uncued slides undefined, for arbitrary input", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 300; run++) {
      const blockSeconds = [0.01, 0.05, 0.46, 1][Math.floor(rand() * 4)]!;
      const length = 20 + Math.floor(rand() * 200);
      const novelty = Array.from({ length }, () => (rand() < 0.15 ? rand() * 10 : 0));
      const analysis: Analysis = { blockSeconds, rate: RATE, novelty };
      const total = length * blockSeconds;
      const sections = Array.from({ length: 1 + Math.floor(rand() * 7) }, (_, i) => ({
        name: i === 1 && rand() < 0.5 ? "Intro" : `S${i}`,
        lines: i === 0 && rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 8),
        lyrics: rand() < 0.7 ? ["words"] : [],
      }));
      const minGapSeconds = rand() < 0.5 ? 0 : rand() * 8;
      const music = planCues(analysis, sections, { minGapSeconds, vocalsOnset: rand() < 0.5 ? rand() * 8 : null });
      const matches = sections.map(() => {
        if (rand() < 0.3) return null;
        const start = Math.round(rand() * total * 10) / 10;
        return { start, end: start + rand() * 10 };
      });
      const lyric = planFromMatches(analysis, sections, matches, { minGapSeconds }) ?? [];
      for (const times of [music, lyric]) {
        strictlyIncreasing(times);
        for (const t of times) if (t !== undefined) expect(Number.isFinite(t)).toBe(true);
      }
      expect(music).toHaveLength(sections.length);
    }
  });
});
