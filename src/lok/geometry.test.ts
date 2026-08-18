import { describe, expect, it } from "vitest";
import { parseSelectionRect, pxToTwips, twipsRectToPx, twipsToPx } from "./geometry.js";

// The measured blank-presentation size from Stage 0/1 (LOK_CAPABILITY_MATRIX.md):
// 15875 x 8930 twips, exactly 16:9 — but geometry.ts must not assume that, so
// tests exercise a non-16:9 size too.
const SCALE_16_9 = { docW: 15875, docH: 8930, renderW: 1280, renderH: 720 };

describe("pxToTwips / twipsToPx", () => {
  it("round-trips the centre point", () => {
    const px = { x: 640, y: 360 };
    const twips = pxToTwips(px, SCALE_16_9);
    const back = twipsToPx(twips, SCALE_16_9);
    expect(back.x).toBeCloseTo(px.x, 0);
    expect(back.y).toBeCloseTo(px.y, 0);
  });

  it("maps the top-left corner to (0, 0) in both directions", () => {
    expect(pxToTwips({ x: 0, y: 0 }, SCALE_16_9)).toEqual({ x: 0, y: 0 });
    expect(twipsToPx({ x: 0, y: 0 }, SCALE_16_9)).toEqual({ x: 0, y: 0 });
  });

  it("maps the bottom-right corner to the full doc/render size", () => {
    const twips = pxToTwips({ x: 1280, y: 720 }, SCALE_16_9);
    expect(twips.x).toBe(15875);
    expect(twips.y).toBe(8930);
  });

  it("does not assume a 16:9 document — a 4:3 size scales independently per axis", () => {
    const scale4x3 = { docW: 12000, docH: 9000, renderW: 1280, renderH: 720 };
    const twips = pxToTwips({ x: 640, y: 360 }, scale4x3);
    // 640/1280 * 12000 = 6000; 360/720 * 9000 = 4500 — different ratios per axis.
    expect(twips).toEqual({ x: 6000, y: 4500 });
  });

  it("pxToTwips rounds to whole twips — LOK coordinates are integers", () => {
    const twips = pxToTwips({ x: 1, y: 1 }, SCALE_16_9);
    expect(Number.isInteger(twips.x)).toBe(true);
    expect(Number.isInteger(twips.y)).toBe(true);
  });
});

describe("twipsRectToPx", () => {
  it("scales origin and size together", () => {
    const rect = twipsRectToPx({ x: 794, y: 356, w: 14286, h: 1490 }, SCALE_16_9);
    expect(rect.x).toBeCloseTo((794 / 15875) * 1280, 1);
    expect(rect.y).toBeCloseTo((356 / 8930) * 720, 1);
    expect(rect.w).toBeCloseTo((14286 / 15875) * 1280, 1);
    expect(rect.h).toBeCloseTo((1490 / 8930) * 720, 1);
  });
});

describe("parseSelectionRect", () => {
  it("parses a real GRAPHIC_SELECTION payload, ignoring trailing part/handle data", () => {
    // Taken verbatim from a real host.cpp run (Stage 1 manual smoke test).
    const payload =
      '794, 356, 14286, 1490, 0, {"id":"106023039090944","type":20, "handles":{}}';
    expect(parseSelectionRect(payload)).toEqual({ x: 794, y: 356, w: 14286, h: 1490 });
  });

  it("returns null for EMPTY", () => {
    expect(parseSelectionRect("EMPTY")).toBeNull();
  });

  it("returns null for EMPTY with trailing fields (seen on INVALIDATE_TILES)", () => {
    expect(parseSelectionRect("EMPTY, 0, 0")).toBeNull();
  });

  it("returns null for an empty or unparseable payload rather than throwing", () => {
    expect(parseSelectionRect("")).toBeNull();
    expect(parseSelectionRect("true")).toBeNull();
    expect(parseSelectionRect("default")).toBeNull();
  });

  it("parses a plain 4-number rect with no trailing part index", () => {
    expect(parseSelectionRect("788, 355, 14297, 1492")).toEqual({
      x: 788, y: 355, w: 14297, h: 1492,
    });
  });
});
