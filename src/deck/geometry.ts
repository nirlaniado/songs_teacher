import { SLIDE_H, SLIDE_W, type SlideElement } from "../schema/deck.js";

/**
 * Editing geometry — snapping, marquee hit-testing and selection bounds.
 *
 * Kept pure and out of the canvas component for the same reason `mix.ts` is
 * kept out of the audio graph: this is the part that can be wrong in ways a
 * pointer-driven UI won't reveal until a user notices their shape landed two
 * units off. Everything here works in slide units (1280x720); nothing knows
 * about screen pixels or the current zoom.
 */

/**
 * Grid spacing, matching Impress's default 10mm on a 25.4cm-wide slide —
 * about 1/32 of the width, which is 40 units here. Coarse enough that snapping
 * visibly tidies a layout, fine enough not to fight deliberate placement.
 */
export const GRID_SIZE = 40;

/** Distance, in slide units, within which a drag latches onto a guide. */
export const SNAP_TOLERANCE = 8;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds extends Frame {
  right: number;
  bottom: number;
}

export function snapToGrid(value: number, grid = GRID_SIZE): number {
  return Math.round(value / grid) * grid;
}

/**
 * The box enclosing a set of elements, or null for an empty set.
 *
 * This is what align, distribute and the multi-selection outline all measure
 * against, so it exists once rather than being recomputed inline three times.
 */
export function boundsOf(elements: readonly SlideElement[]): Bounds | null {
  if (elements.length === 0) return null;
  const x = Math.min(...elements.map((el) => el.x));
  const y = Math.min(...elements.map((el) => el.y));
  const right = Math.max(...elements.map((el) => el.x + el.w));
  const bottom = Math.max(...elements.map((el) => el.y + el.h));
  return { x, y, w: right - x, h: bottom - y, right, bottom };
}

/** Normalises a drag rectangle so dragging up-left works like down-right. */
export function normalizeRect(ax: number, ay: number, bx: number, by: number): Frame {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/**
 * Elements the marquee selects.
 *
 * Impress selects on *enclosure*, not intersection: a rubber band that merely
 * clips the corner of a full-width title shouldn't take it. Selecting by touch
 * makes a band drawn across a slide grab nearly everything, which is exactly
 * the case where a user is trying to be precise.
 */
export function elementsInRect(
  elements: readonly SlideElement[],
  rect: Frame,
): SlideElement[] {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  return elements.filter(
    (el) => el.x >= rect.x && el.y >= rect.y && el.x + el.w <= right && el.y + el.h <= bottom,
  );
}

/** The topmost element under a point, matching the canvas's paint order. */
export function elementAt(
  elements: readonly SlideElement[],
  x: number,
  y: number,
): SlideElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h) return el;
  }
  return null;
}

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

/**
 * Where one element lands when aligned within `to`.
 *
 * Split out from `apply.ts`'s op handler so the toolbar and the agent cannot
 * drift apart on what "align right" means — the op is still the only thing
 * that mutates a deck, but the arithmetic is defined once.
 */
export function alignedFrame(el: Frame, to: Bounds, mode: AlignMode): { x?: number; y?: number } {
  switch (mode) {
    case "left":
      return { x: to.x };
    case "center":
      return { x: to.x + (to.w - el.w) / 2 };
    case "right":
      return { x: to.right - el.w };
    case "top":
      return { y: to.y };
    case "middle":
      return { y: to.y + (to.h - el.h) / 2 };
    case "bottom":
      return { y: to.bottom - el.h };
  }
}

/** The whole slide as a bounds, for "align relative to the slide". */
export function slideBounds(): Bounds {
  return { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, right: SLIDE_W, bottom: SLIDE_H };
}

/**
 * Guide lines a moving frame should latch onto: the slide's edges and centre,
 * plus the edges and centres of every element that isn't moving.
 *
 * Returned as bare coordinates rather than objects so the caller can render
 * exactly the ones that matched — a snap the user can't see reads as the
 * editor moving things by itself.
 */
export function snapTargets(others: readonly SlideElement[]): { x: number[]; y: number[] } {
  const x = [0, SLIDE_W / 2, SLIDE_W];
  const y = [0, SLIDE_H / 2, SLIDE_H];
  for (const el of others) {
    x.push(el.x, el.x + el.w / 2, el.x + el.w);
    y.push(el.y, el.y + el.h / 2, el.y + el.h);
  }
  return { x, y };
}

export interface SnapResult {
  x: number;
  y: number;
  /** Coordinates that actually matched, for drawing the guide lines. */
  guides: { x: number[]; y: number[] };
}

/**
 * Nudges a frame onto the nearest guide on each axis.
 *
 * Tries the frame's leading edge, centre and trailing edge, and keeps the
 * closest match within tolerance — so a shape can align by any of its edges,
 * which is what makes snapping feel like Impress rather than like a magnet.
 */
export function snapFrame(
  frame: Frame,
  targets: { x: number[]; y: number[] },
  tolerance = SNAP_TOLERANCE,
): SnapResult {
  const result: SnapResult = { x: frame.x, y: frame.y, guides: { x: [], y: [] } };

  const axis = (
    origin: number,
    size: number,
    candidates: number[],
  ): { value: number; guide: number } | null => {
    let best: { value: number; guide: number; distance: number } | null = null;
    for (const offset of [0, size / 2, size]) {
      for (const candidate of candidates) {
        const distance = Math.abs(origin + offset - candidate);
        if (distance > tolerance) continue;
        if (!best || distance < best.distance) {
          best = { value: candidate - offset, guide: candidate, distance };
        }
      }
    }
    return best ? { value: best.value, guide: best.guide } : null;
  };

  const hitX = axis(frame.x, frame.w, targets.x);
  if (hitX) {
    result.x = hitX.value;
    result.guides.x.push(hitX.guide);
  }
  const hitY = axis(frame.y, frame.h, targets.y);
  if (hitY) {
    result.y = hitY.value;
    result.guides.y.push(hitY.guide);
  }
  return result;
}
