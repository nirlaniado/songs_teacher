import { describe, expect, it } from "vitest";
import type { Slide } from "../schema/deck.js";
import { sectionsOfSlides } from "./autoCue.js";

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
