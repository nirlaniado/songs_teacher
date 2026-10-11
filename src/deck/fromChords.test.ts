import { describe, expect, it } from "vitest";
import { chordDeckSlides, chordSectionPlan } from "./fromChords.js";
import { Deck, newDeck } from "../schema/deck.js";
import type { ChordLine, ChordResult } from "../ug/types.js";

/** A fresh, deterministic id sequence — asserted against, not just "truthy". */
function idCounter() {
  let n = 0;
  return () => `id-${++n}`;
}

function chordLine(section: string | null, chords: string[], lyric: string | null = null): ChordLine {
  return { section, sourceLine: 0, chords, row: chords.join("   "), lyric };
}

function result(overrides: Partial<ChordResult> = {}): ChordResult {
  return {
    source: {
      id: "1",
      title: "Viva La Vida",
      artist: "Coldplay",
      url: "https://tabs.ultimate-guitar.com/example",
      official: true,
      version: 1,
      views: 100000,
    },
    retrievedAt: "2026-01-01T00:00:00.000Z",
    selection: "official",
    warning: null,
    capo: null,
    tuning: null,
    key: null,
    lines: [],
    uniqueChords: [],
    chart: "",
    ...overrides,
  };
}

describe("chordDeckSlides — cover slide", () => {
  it("puts the title and artist in the right frames", () => {
    const [cover] = chordDeckSlides(result(), idCounter());
    const title = cover!.elements.find((el) => el.kind === "text" && el.role === "title");
    const body = cover!.elements.find((el) => el.kind === "text" && el.role === "body");
    expect(title?.kind === "text" && title.text).toBe("Viva La Vida");
    expect(body?.kind === "text" && body.text).toBe("Coldplay");
    expect(cover!.name).toBe("Title");
    expect(cover!.layout).toBe("centered");
  });

  it("appends a meta line for whichever of key/capo/tuning are known", () => {
    const [cover] = chordDeckSlides(result({ key: "G", capo: 2, tuning: "Drop D" }), idCounter());
    const body = cover!.elements.find((el) => el.kind === "text" && el.role === "body");
    expect(body?.kind === "text" && body.text).toBe("Coldplay\nKey: G · Capo: 2 · Tuning: Drop D");
  });

  it("omits the meta line entirely when key/capo/tuning are all null", () => {
    const [cover] = chordDeckSlides(result(), idCounter());
    const body = cover!.elements.find((el) => el.kind === "text" && el.role === "body");
    expect(body?.kind === "text" && body.text).toBe("Coldplay");
  });

  it("shows a capo of 0 rather than silently dropping it", () => {
    const [cover] = chordDeckSlides(result({ capo: 0 }), idCounter());
    const body = cover!.elements.find((el) => el.kind === "text" && el.role === "body");
    expect(body?.kind === "text" && body.text).toContain("Capo: 0");
  });
});

describe("chordDeckSlides — section grouping", () => {
  it("groups consecutive same-section lines into one slide each, in song order", () => {
    const slides = chordDeckSlides(
      result({
        lines: [
          chordLine("Verse 1", ["G", "D"]),
          chordLine("Verse 1", ["Em", "C"]),
          chordLine("Chorus", ["C", "G"]),
          chordLine("Verse 2", ["G", "D"]),
          chordLine("Chorus", ["C", "G"]),
        ],
      }),
      idCounter(),
    );
    // Cover slide + one slide per group (4 groups: Verse 1, Chorus, Verse 2, Chorus).
    expect(slides).toHaveLength(5);
    expect(slides.slice(1).map((s) => s.name)).toEqual(["Verse 1", "Chorus (1)", "Verse 2", "Chorus (2)"]);
  });

  it("groups a leading run of unheaded lines into one slide labelled 'Chords'", () => {
    const slides = chordDeckSlides(
      result({
        lines: [chordLine(null, ["G"]), chordLine(null, ["D"]), chordLine("Verse 1", ["Em"])],
      }),
      idCounter(),
    );
    expect(slides.slice(1).map((s) => s.name)).toEqual(["Chords", "Verse 1"]);
  });

  it("leaves a section label used only once bare, with no suffix", () => {
    const slides = chordDeckSlides(
      result({ lines: [chordLine("Bridge", ["Am"]), chordLine("Outro", ["G"])] }),
      idCounter(),
    );
    expect(slides.slice(1).map((s) => s.name)).toEqual(["Bridge", "Outro"]);
  });

  it("produces just the cover slide when there are no chord lines at all", () => {
    const slides = chordDeckSlides(result(), idCounter());
    expect(slides).toHaveLength(1);
  });
});

describe("chordDeckSlides — section slide content", () => {
  it("renders each section's chords as a single TabElement, never a TextElement, in order", () => {
    const slides = chordDeckSlides(
      result({
        lines: [chordLine("Verse 1", ["G", "D", "Em"]), chordLine("Verse 1", ["C", "G"])],
      }),
      idCounter(),
    );
    const section = slides[1]!;
    const tabs = section.elements.filter((el) => el.kind === "tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.text).toBe(["G   D   Em", "C   G"].join("\n"));
    // The title placeholder survives; the body TextElement was replaced by the tab, not kept alongside it.
    expect(section.elements.filter((el) => el.kind === "text" && el.role === "body")).toHaveLength(0);
    expect(section.elements.some((el) => el.kind === "text" && el.role === "title" && el.text === "Verse 1")).toBe(
      true,
    );
  });

  it("gives the tab element the body frame's box geometry", () => {
    const slides = chordDeckSlides(result({ lines: [chordLine("Verse 1", ["G"])] }), idCounter());
    const tab = slides[1]!.elements.find((el) => el.kind === "tab")!;
    expect(tab.w).toBeGreaterThan(0);
    expect(tab.h).toBeGreaterThan(0);
  });
});

describe("chordDeckSlides — no timing or audio", () => {
  it("never sets startTime on a generated slide", () => {
    const slides = chordDeckSlides(
      result({ lines: [chordLine("Verse 1", ["G"]), chordLine("Chorus", ["C"])] }),
      idCounter(),
    );
    for (const slide of slides) expect(slide.startTime).toBeUndefined();
  });
});

describe("chordDeckSlides — ids", () => {
  it("assigns a fresh id to every slide and element from the given generator", () => {
    const counter = idCounter();
    const slides = chordDeckSlides(
      result({ lines: [chordLine("Verse 1", ["G", "D"])] }),
      counter,
    );
    const allIds = [
      ...slides.map((s) => s.id),
      ...slides.flatMap((s) => s.elements.map((el) => el.id)),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.every((id) => id.startsWith("id-"))).toBe(true);
  });
});

describe("chordDeckSlides — validates as a real deck", () => {
  it("parses cleanly once assembled into a Deck", () => {
    // Real UUIDs here, not the "id-N" counter above — Slide/element ids are
    // z.uuid()-constrained, and this test exists specifically to catch a
    // shape Deck.parse would reject.
    const slides = chordDeckSlides(
      result({
        key: "G",
        capo: 2,
        tuning: "Drop D",
        lines: [
          chordLine(null, ["G", "D"]),
          chordLine("Verse 1", ["Em", "C"]),
          chordLine("Chorus", ["C", "G", "D"]),
        ],
      }),
      () => crypto.randomUUID(),
    );
    const draft = newDeck({ id: crypto.randomUUID(), title: "Viva La Vida — Coldplay" });
    expect(() => Deck.parse({ ...draft, slides })).not.toThrow();
  });
});

describe("chordDeckSlides — lyrics", () => {
  it("shows each chord row with its lyric directly under it, keeping the chord spacing", () => {
    const slides = chordDeckSlides(
      result({
        lines: [
          { section: "Verse 1", sourceLine: 1, chords: ["G", "D"], row: "G        D", lyric: "Hello darkness my old friend" },
          { section: "Verse 1", sourceLine: 3, chords: ["Em"], row: "Em", lyric: null },
        ],
      }),
      idCounter(),
    );
    const tab = slides[1]!.elements.find((el) => el.kind === "tab")!;
    expect(tab.text).toBe(["G        D", "Hello darkness my old friend", "Em"].join("\n"));
  });
});

describe("chordSectionPlan", () => {
  it("lists a cover with no lyrics, then each section's name, line count and lyrics, in slide order", () => {
    const plan = chordSectionPlan(
      result({
        lines: [
          chordLine("Intro", ["Am"]),
          chordLine("Verse 1", ["G"], "first line"),
          chordLine("Verse 1", ["D"], "second line"),
          chordLine("Chorus", ["C"], "sing along"),
        ],
      }),
    );
    expect(plan).toEqual([
      { name: "Title", lines: 0, lyrics: [] },
      { name: "Intro", lines: 1, lyrics: [] },
      { name: "Verse 1", lines: 2, lyrics: ["first line", "second line"] },
      { name: "Chorus", lines: 1, lyrics: ["sing along"] },
    ]);
  });

  it("uses the same names as the generated slides, so times line up one-to-one", () => {
    const r = result({ lines: [chordLine("Chorus", ["C"], "x y z"), chordLine("Verse 1", ["G"], "a b c"), chordLine("Chorus", ["C"], "x y z")] });
    expect(chordSectionPlan(r).map((s) => s.name)).toEqual(chordDeckSlides(r, idCounter()).map((s) => s.name));
  });
});
