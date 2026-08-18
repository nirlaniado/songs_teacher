/**
 * Coordinate conversion between the canvas's rendered pixels and LOK's
 * document space (twips — 1/1440 inch), plus parsing for the selection/
 * cursor rectangles LOK's callbacks carry as plain comma-separated text.
 *
 * Same discipline as `deck/geometry.ts`: pure functions, unit-tested, no DOM.
 * `LokCanvas` converts at the edge (pointer events in, overlay boxes out) and
 * never stores a pixel value — same reasoning as the app's fixed 1280×720
 * slide space, applied one level lower.
 */

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export interface TwipsPoint {
  readonly x: number;
  readonly y: number;
}

export interface TwipsRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Document size in twips (from `/api/project`) and the canvas's rendered
 *  pixel size — not assumed equal, and not assumed 16:9: a document opened
 *  from a real file can be any size or aspect ratio. */
export interface CanvasScale {
  readonly docW: number;
  readonly docH: number;
  readonly renderW: number;
  readonly renderH: number;
}

export function pxToTwips(p: PixelPoint, scale: CanvasScale): TwipsPoint {
  return {
    x: Math.round((p.x / scale.renderW) * scale.docW),
    y: Math.round((p.y / scale.renderH) * scale.docH),
  };
}

export function twipsToPx(p: TwipsPoint, scale: CanvasScale): PixelPoint {
  return {
    x: (p.x / scale.docW) * scale.renderW,
    y: (p.y / scale.docH) * scale.renderH,
  };
}

export function twipsRectToPx(r: TwipsRect, scale: CanvasScale): PixelRect {
  const origin = twipsToPx({ x: r.x, y: r.y }, scale);
  return {
    x: origin.x,
    y: origin.y,
    w: (r.w / scale.docW) * scale.renderW,
    h: (r.h / scale.docH) * scale.renderH,
  };
}

/**
 * LOK's selection/cursor callbacks carry their rectangle as plain
 * comma-separated numbers (`"794, 356, 14286, 1490, 0, {…handles…}"`), not
 * JSON — measured directly off the real host in Stage 1 (host.ts's
 * `lokevent` payloads). `"EMPTY"` (bare, or as the first token) means no
 * selection. Trailing fields (part index, handle JSON for a graphic
 * selection) are ignored — only the leading x, y, w, h rectangle is what a
 * selection overlay needs.
 */
export function parseSelectionRect(payload: string): TwipsRect | null {
  const trimmed = payload.trim();
  if (trimmed === "" || trimmed.startsWith("EMPTY")) return null;

  const firstFour = trimmed.split(",").slice(0, 4).map((s) => Number(s.trim()));
  if (firstFour.length < 4 || firstFour.some((n) => !Number.isFinite(n))) return null;

  const [x, y, w, h] = firstFour as [number, number, number, number];
  return { x, y, w, h };
}
