import { describe, expect, it } from "vitest";
import type { DeckSummary } from "../schema/deck.js";
import { filterDecks, newestFirst, waveformBars } from "./library.js";

const deck = (title: string, updatedAt = "2026-10-01T00:00:00.000Z"): DeckSummary => ({
  id: crypto.randomUUID(),
  title,
  slideCount: 1,
  hasAudio: false,
  updatedAt,
});

// Escaped because the source itself stays free of Hebrew; a teacher's titles are data, and can hold any script.
const HEBREW_TITLE = "\u05e9\u05dc\u05d5\u05dd \u05d7\u05d1\u05e8";

describe("filterDecks", () => {
  const decks = [deck("Someone Like You — Adele"), deck("Until the End"), deck(HEBREW_TITLE)];

  it("matches any part of a title, ignoring case and surrounding space", () => {
    expect(filterDecks(decks, "  ADELE ").map((d) => d.title)).toEqual(["Someone Like You — Adele"]);
  });

  it("finds a title in another script, since titles hold whatever the teacher typed", () => {
    expect(filterDecks(decks, HEBREW_TITLE.slice(0, 4))).toHaveLength(1);
  });

  it("returns nothing, rather than everything, when nothing matches", () => {
    expect(filterDecks(decks, "zzz")).toEqual([]);
  });

  it("treats a blank search as no search, and hands back the same array so nothing re-renders", () => {
    expect(filterDecks(decks, "   ")).toBe(decks);
  });
});

describe("newestFirst", () => {
  it("orders by last update without touching the store's array", () => {
    const decks = [deck("old", "2026-01-01T00:00:00.000Z"), deck("new", "2026-10-01T00:00:00.000Z")];
    expect(newestFirst(decks).map((d) => d.title)).toEqual(["new", "old"]);
    expect(decks[0]!.title).toBe("old");
  });
});

describe("waveformBars", () => {
  const a = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
  const b = "6f9619ff-8b86-4d01-b42d-00cf4fc964fe";

  it("is pure: one id gives one shape, every time", () => {
    expect(waveformBars(a, 64)).toEqual(waveformBars(a, 64));
  });

  it("gives ids a single character apart different shapes, since a repeated shape reads as a placeholder", () => {
    expect(waveformBars(a, 64)).not.toEqual(waveformBars(b, 64));
  });

  it("makes as many bars as asked, all drawable", () => {
    const bars = waveformBars(a, 80);
    expect(bars).toHaveLength(80);
    for (const bar of bars) {
      expect(bar).toBeGreaterThan(0);
      expect(bar).toBeLessThanOrEqual(1);
    }
  });

  it("varies along its length, so it reads as a waveform rather than a bar", () => {
    expect(new Set(waveformBars(a, 80)).size).toBeGreaterThan(30);
  });
});
