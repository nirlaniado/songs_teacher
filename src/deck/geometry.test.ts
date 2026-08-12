import { describe, expect, it } from "vitest";
import { SLIDE_H, SLIDE_W, type SlideElement } from "../schema/deck.js";
import {
  alignedFrame,
  boundsOf,
  elementAt,
  elementsInRect,
  normalizeRect,
  slideBounds,
  snapFrame,
  snapTargets,
  snapToGrid,
} from "./geometry.js";

/** A shape at a given frame — enough of an element for geometry to work on. */
function box(id: string, x: number, y: number, w = 100, h = 100): SlideElement {
  return { id, kind: "shape", x, y, w, h, rotation: 0, locked: false, shape: "rect", strokeWidth: 0 };
}

describe("snapToGrid", () => {
  it("rounds to the nearest gridline in both directions", () => {
    expect(snapToGrid(38)).toBe(40);
    expect(snapToGrid(42)).toBe(40);
    expect(snapToGrid(-18)).toBe(-0);
  });
});

describe("boundsOf", () => {
  it("encloses every element", () => {
    const bounds = boundsOf([box("a", 100, 50), box("b", 300, 200, 50, 50)])!;
    expect(bounds).toMatchObject({ x: 100, y: 50, right: 350, bottom: 250, w: 250, h: 200 });
  });

  it("is null for an empty selection, so callers can't average nothing", () => {
    // Math.min() of an empty list is Infinity, which would silently produce a
    // bounding box the size of the universe.
    expect(boundsOf([])).toBeNull();
  });
});

describe("elementsInRect", () => {
  const elements = [box("inside", 100, 100), box("clipped", 250, 100), box("far", 900, 500)];

  it("takes only fully enclosed elements", () => {
    // Impress selects on enclosure. Selecting on touch means a band drawn
    // across a slide grabs everything it brushes — the opposite of precise.
    const picked = elementsInRect(elements, { x: 50, y: 50, w: 250, h: 250 });
    expect(picked.map((el) => el.id)).toEqual(["inside"]);
  });

  it("takes several when the band covers them", () => {
    const picked = elementsInRect(elements, { x: 0, y: 0, w: 400, h: 400 });
    expect(picked.map((el) => el.id)).toEqual(["inside", "clipped"]);
  });

  it("returns nothing for a band over empty space", () => {
    expect(elementsInRect(elements, { x: 600, y: 50, w: 100, h: 100 })).toEqual([]);
  });
});

describe("normalizeRect", () => {
  it("handles a drag towards the top-left the same as one towards the bottom-right", () => {
    expect(normalizeRect(300, 300, 100, 100)).toEqual({ x: 100, y: 100, w: 200, h: 200 });
    expect(normalizeRect(100, 100, 300, 300)).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });
});

describe("elementAt", () => {
  it("returns the topmost element, matching paint order", () => {
    // Later elements paint on top, so a click must resolve to the last match,
    // not the first — otherwise clicking a shape selects whatever is under it.
    const stacked = [box("under", 100, 100), box("over", 120, 120)];
    expect(elementAt(stacked, 150, 150)?.id).toBe("over");
  });

  it("returns null over empty space", () => {
    expect(elementAt([box("a", 100, 100)], 500, 500)).toBeNull();
  });
});

describe("alignedFrame", () => {
  const group = boundsOf([box("a", 100, 100, 200, 100), box("b", 400, 300, 100, 100)])!;

  it("aligns to the leading, centre and trailing edges of the bounds", () => {
    expect(alignedFrame({ x: 400, y: 300, w: 100, h: 100 }, group, "left")).toEqual({ x: 100 });
    expect(alignedFrame({ x: 100, y: 100, w: 200, h: 100 }, group, "right")).toEqual({ x: 300 });
    expect(alignedFrame({ x: 100, y: 100, w: 200, h: 100 }, group, "center")).toEqual({ x: 200 });
  });

  it("only touches the axis it is asked about", () => {
    // Aligning left must not also move an element vertically; two commands are
    // two commands.
    expect(alignedFrame({ x: 0, y: 0, w: 10, h: 10 }, group, "top")).toEqual({ y: 100 });
    expect(alignedFrame({ x: 0, y: 0, w: 10, h: 10 }, group, "left")).toEqual({ x: 100 });
  });

  it("centres on the slide when given the slide's bounds", () => {
    const centred = alignedFrame({ x: 0, y: 0, w: 400, h: 200 }, slideBounds(), "center");
    expect(centred.x).toBe((SLIDE_W - 400) / 2);
  });
});

describe("snapFrame", () => {
  const targets = snapTargets([box("other", 400, 200, 200, 100)]);

  it("latches the leading edge onto a neighbour's edge", () => {
    const snapped = snapFrame({ x: 404, y: 500, w: 100, h: 50 }, targets);
    expect(snapped.x).toBe(400);
    expect(snapped.guides.x).toEqual([400]);
  });

  it("latches the trailing edge too, so shapes can butt up against each other", () => {
    // Right edge at 596, four units short of the neighbour's right edge (600).
    const snapped = snapFrame({ x: 496, y: 500, w: 100, h: 50 }, targets);
    expect(snapped.x).toBe(500);
  });

  it("snaps to the slide's centre line", () => {
    const snapped = snapFrame({ x: SLIDE_W / 2 - 3, y: 500, w: 100, h: 50 }, targets);
    expect(snapped.x).toBe(SLIDE_W / 2);
  });

  it("leaves a frame alone when nothing is within tolerance", () => {
    const frame = { x: 137, y: 411, w: 90, h: 40 };
    const snapped = snapFrame(frame, targets);
    expect(snapped.x).toBe(137);
    expect(snapped.y).toBe(411);
    expect(snapped.guides).toEqual({ x: [], y: [] });
  });

  it("reports the guides that matched, so the snap is visible", () => {
    // A snap the user can't see reads as the editor moving things by itself.
    const snapped = snapFrame({ x: 2, y: SLIDE_H - 52, w: 100, h: 50 }, targets);
    expect(snapped.guides.x).toEqual([0]);
    expect(snapped.guides.y).toEqual([SLIDE_H]);
  });
});
