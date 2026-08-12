import { describe, expect, it } from "vitest";
import { TUNING_PRESETS, padTabLines, tabScaffold, tuningById } from "./templates.js";

/**
 * The tuning note names, pinned so a future edit can't silently drift a
 * string's pitch — these are read by a music teacher, and a wrong note name
 * in a "Drop C#" preset is a worse bug than most, because nothing else in the
 * app would ever notice it.
 */
describe("TUNING_PRESETS", () => {
  it("has exactly six strings, high to low, for every preset", () => {
    for (const tuning of TUNING_PRESETS) expect(tuning.strings).toHaveLength(6);
  });

  it("matches the standard names for each tuning, high string to low", () => {
    const byId = Object.fromEntries(TUNING_PRESETS.map((t) => [t.id, t.strings]));
    expect(byId["standard"]).toEqual(["e", "B", "G", "D", "A", "E"]);
    expect(byId["half-down"]).toEqual(["eb", "Bb", "Gb", "Db", "Ab", "Eb"]);
    expect(byId["half-up"]).toEqual(["f", "C", "Ab", "Eb", "Bb", "F"]);
    // Drop tunings only change the lowest string(s); the top five stay
    // "standard-shaped" for Drop D, and shift together for Drop C / C#.
    expect(byId["drop-d"]).toEqual(["e", "B", "G", "D", "A", "D"]);
    expect(byId["drop-c"]).toEqual(["d", "A", "F", "C", "G", "C"]);
    expect(byId["drop-csharp"]).toEqual(["d#", "A#", "F#", "C#", "G#", "D#"]);
  });

  it("lowercases only the top string, consistently across every preset", () => {
    // The e/E convention exists to disambiguate the two same-named strings in
    // standard tuning; applied uniformly here rather than case-by-case so the
    // rule is predictable instead of "sometimes lowercase, sometimes not".
    for (const tuning of TUNING_PRESETS) {
      const [top, ...rest] = tuning.strings;
      expect(top).toBe(top!.toLowerCase());
      for (const s of rest) expect(s).toBe(s[0]!.toUpperCase() + s.slice(1));
    }
  });

  it("falls back to standard for an unknown id, rather than throwing", () => {
    expect(tuningById("nonsense").id).toBe("standard");
  });
});

describe("tabScaffold", () => {
  it("renders one labelled, dash-filled line per string, in order", () => {
    const scaffold = tabScaffold(tuningById("standard"));
    expect(scaffold).toBe(
      ["e|-------", "B|-------", "G|-------", "D|-------", "A|-------", "E|-------"].join("\n"),
    );
  });

  it("carries no fret numbers — bare structure, not musical content", () => {
    for (const tuning of TUNING_PRESETS) {
      const lines = tabScaffold(tuning).split("\n");
      for (const line of lines) expect(line.split("|")[1]).toMatch(/^-+$/);
    }
  });
});

describe("padTabLines", () => {
  it("pads ragged lines to the longest one, appending dashes only", () => {
    const ragged = ["---2", "-----------", "-------3---"].join("\n");
    const padded = padTabLines(ragged);
    const lines = padded.split("\n");
    expect(lines).toHaveLength(3);
    // Every line reaches the width of the longest original line.
    const width = Math.max(...lines.map((l) => l.length));
    for (const line of lines) expect(line).toHaveLength(width);
    // Nothing already typed moves — the fret numbers stay exactly where they were.
    expect(lines[0]!.startsWith("---2")).toBe(true);
    expect(lines[2]).toBe("-------3---");
  });

  it("is a no-op when every line already matches", () => {
    const even = ["e|-------", "B|-------"].join("\n");
    expect(padTabLines(even)).toBe(even);
  });

  it("leaves a single line and an empty string alone", () => {
    expect(padTabLines("---2--")).toBe("---2--");
    expect(padTabLines("")).toBe("");
  });
});
