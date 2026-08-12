import {
  Deck,
  SLIDE_H,
  SLIDE_W,
  type LayoutId,
  type Slide,
  type SlideElement,
} from "../schema/deck.js";
import { applyLayout, layoutById, THEME_PRESETS } from "../deck/templates.js";
import type { NewSlideSpec, Op } from "./ops.js";
import { resolveTarget } from "./targets.js";

/** Loose comparison so "warm paper", "Warm Paper" and "paper" all match. */
function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Applies a batch of ops as one pure `Deck -> Deck` transform.
 *
 * Purity is load-bearing, for two reasons:
 *
 * 1. **Undo.** `deckStore.commit()` records one snapshot per mutation, so
 *    driving the existing per-slide actions in a loop would turn a single
 *    instruction into ten undo steps. Transforming the whole deck once means
 *    one snapshot, one re-render, one Ctrl+Z.
 * 2. **Validation before the user commits.** The caller can run this against
 *    the current deck, `Deck.safeParse` the result, and show any problem in
 *    the preview — rather than letting an invalid deck reach the editor and
 *    fail later at save time. The forward-cue invariant in `Deck.superRefine`
 *    makes that a real possibility, not a theoretical one.
 *
 * Ops apply in order, each seeing the previous one's result, so
 * "create the slides, then put text on them" works as a single batch.
 */

export interface ApplyResult {
  deck: Deck;
  /** One line per op describing what actually happened, for the applied-log. */
  summary: string[];
}

const newId = () => crypto.randomUUID();

/** A fresh slide with its layout's placeholder frames already laid out. */
function makeSlide(spec: NewSlideSpec, layout: LayoutId): Slide {
  const elements = applyLayout([], layout, newId).map((el) => {
    if (el.kind !== "text") return el;
    if (el.role === "title") return { ...el, text: spec.title };
    if (el.role === "body" && spec.body) return { ...el, text: spec.body };
    return el;
  });
  return {
    id: newId(),
    // Falls back to the title, since that's what the slide rail, the Music
    // sync rows and name-based targeting all read — an untitled-but-named
    // slide would be untargetable by the name the user just typed.
    name: (spec.name ?? spec.title).trim() || layoutById(layout).label,
    layout,
    elements,
  };
}

/**
 * Writes text into the first placeholder of `role`, adding one if the slide's
 * layout has none — so `setTitle` on a blank slide still lands somewhere
 * visible rather than silently doing nothing.
 */
function writeToRole(
  slide: Slide,
  role: "title" | "body",
  text: string,
  mode: "set" | "append",
): Slide {
  const index = slide.elements.findIndex((el) => el.kind === "text" && el.role === role);

  if (index === -1) {
    const frame = applyLayout([], role === "title" ? "title" : "contentOnly", newId).find(
      (el): el is Extract<SlideElement, { kind: "text" }> => el.kind === "text",
    );
    if (!frame) return slide;
    return { ...slide, elements: [...slide.elements, { ...frame, role, text }] };
  }

  const elements = [...slide.elements];
  const current = elements[index]!;
  if (current.kind !== "text") return slide;
  const next =
    mode === "append" && current.text.trim() !== "" ? `${current.text}\n${text}` : text;
  elements[index] = { ...current, text: next };
  return { ...slide, elements };
}

function mapTargeted(
  deck: Deck,
  indexes: readonly number[],
  fn: (slide: Slide) => Slide,
): Deck {
  const picked = new Set(indexes);
  return { ...deck, slides: deck.slides.map((s, i) => (picked.has(i) ? fn(s) : s)) };
}

export function applyOps(input: Deck, ops: readonly Op[], currentSlide = 0): ApplyResult {
  let deck = input;
  const summary: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "createSlides": {
        const made = op.slides.map((spec) => makeSlide(spec, spec.layout ?? "titleContent"));
        const at = Math.min(op.at ?? deck.slides.length, deck.slides.length);
        const slides = [...deck.slides];
        slides.splice(at, 0, ...made);
        deck = { ...deck, slides };
        summary.push(`Created ${made.length} slide${made.length === 1 ? "" : "s"}`);
        break;
      }

      case "setTitle":
      case "setBody":
      case "appendBody": {
        const role = op.op === "setTitle" ? "title" : "body";
        const mode = op.op === "appendBody" ? "append" : "set";
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => writeToRole(s, role, op.text, mode));
        summary.push(`Updated ${role} on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "setNotes": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => ({ ...s, notes: op.text || undefined }));
        summary.push(`Set notes on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "renameSlide": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        // Numbered automatically when renaming several at once, otherwise every
        // targeted slide would end up with an identical, untargetable name.
        const picked = new Set(indexes);
        let n = 0;
        deck = {
          ...deck,
          slides: deck.slides.map((s, i) => {
            if (!picked.has(i)) return s;
            n += 1;
            return { ...s, name: indexes.length > 1 ? `${op.name} ${n}` : op.name };
          }),
        };
        summary.push(`Renamed ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "setLayout": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => ({
          ...s,
          layout: op.layout,
          // Reuse the editor's own layout switch so text carries across by
          // role and hand-placed elements survive, exactly as in the UI.
          elements: applyLayout(s.elements, op.layout, newId),
        }));
        summary.push(`Set layout on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "moveSlide": {
        const { from, to } = op;
        if (from < deck.slides.length && to < deck.slides.length && from !== to) {
          const slides = [...deck.slides];
          const [moved] = slides.splice(from, 1);
          slides.splice(to, 0, moved!);
          deck = { ...deck, slides };
          summary.push(`Moved slide ${from + 1} to position ${to + 1}`);
        }
        break;
      }

      case "deleteSlides": {
        const drop = new Set(resolveTarget(deck, op.target, currentSlide));
        deck = { ...deck, slides: deck.slides.filter((_, i) => !drop.has(i)) };
        summary.push(`Deleted ${drop.size} slide${drop.size === 1 ? "" : "s"}`);
        break;
      }

      case "setCue": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => ({ ...s, startTime: op.seconds }));
        summary.push(`Cued ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "clearCue": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => ({ ...s, startTime: undefined }));
        summary.push(`Cleared cue on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "setTheme": {
        // A named preset is the base; explicit colours layer on top, so
        // "dark theme with an orange accent" is one op, not two.
        // Matched on id *or* label — a model is far likelier to say
        // "warm paper" (the label) than "paper" (the id).
        const wanted = op.preset ? normalizeName(op.preset) : null;
        const preset =
          wanted === null
            ? undefined
            : THEME_PRESETS.find(
                (p) => normalizeName(p.preset) === wanted || normalizeName(p.label) === wanted,
              );
        const base = preset ? { ...deck.theme, ...preset } : deck.theme;
        const { label: _drop, ...cleaned } = base as typeof base & { label?: string };
        deck = {
          ...deck,
          theme: {
            ...cleaned,
            ...(op.background ? { background: { kind: "color", color: op.background } } : {}),
            ...(op.text ? { text: op.text } : {}),
            ...(op.accent ? { accent: op.accent } : {}),
            ...(op.fontFamily ? { fontFamily: op.fontFamily } : {}),
            // Any hand-set colour means this is no longer a stock preset.
            preset:
              op.background || op.text || op.accent || op.fontFamily
                ? "custom"
                : (preset?.preset ?? deck.theme.preset),
          },
        };
        summary.push("Updated the deck design");
        break;
      }

      case "setSlideBackground": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => ({
          ...s,
          background: { kind: "color", color: op.color },
        }));
        summary.push(`Set the background on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "clearSlideBackground": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (s) => {
          const { background: _inherit, ...rest } = s;
          return rest as Slide;
        });
        summary.push(`Reset the background on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "addImage": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: [
            ...slide.elements,
            {
              kind: "image" as const,
              id: newId(),
              // Bottom-right by default. Layout body frames run full-width
              // and reach ~y=480 (the centered layout's does), so anything
              // higher lands on top of text; this sits below all of them and
              // inside the 1280x720 slide with a margin to spare.
              x: op.x ?? SLIDE_W - 260 - 48,
              y: op.y ?? SLIDE_H - 200 - 32,
              w: op.w ?? 260,
              h: op.h ?? 200,
              rotation: 0,
              locked: false,
              src: op.src,
              fit: op.fit ?? "contain",
            },
          ],
        }));
        summary.push(`Placed an image on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "addTextBox": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: [
            ...slide.elements,
            {
              kind: "text" as const,
              id: newId(),
              text: op.text,
              role: "none" as const,
              x: op.x ?? 80,
              y: op.y ?? 80,
              w: op.w ?? 480,
              h: op.h ?? 160,
              rotation: op.rotation ?? 0,
              locked: op.locked ?? false,
              style: {
                fontSize: 32,
                bold: false,
                italic: false,
                underline: false,
                align: "left" as const,
                valign: "top" as const,
                lineHeight: 1.25,
                ...op.style,
              },
            },
          ],
        }));
        summary.push(`Added a text box to ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "addShape": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: [
            ...slide.elements,
            {
              kind: "shape" as const,
              id: newId(),
              shape: op.shape,
              x: op.x ?? 100,
              y: op.y ?? 100,
              w: op.w ?? 300,
              h: op.h ?? 160,
              rotation: op.rotation ?? 0,
              locked: op.locked ?? false,
              fill: op.fill,
              stroke: op.stroke,
              strokeWidth: op.strokeWidth ?? 0,
            },
          ],
        }));
        summary.push(`Added a shape to ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }

      case "updateElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (!ids.has(el.id)) return el;
            changed += 1;
            return {
              ...el,
              ...(op.x !== undefined ? { x: op.x } : {}),
              ...(op.y !== undefined ? { y: op.y } : {}),
              ...(op.w !== undefined ? { w: op.w } : {}),
              ...(op.h !== undefined ? { h: op.h } : {}),
              ...(op.rotation !== undefined ? { rotation: op.rotation } : {}),
              ...(op.locked !== undefined ? { locked: op.locked } : {}),
            };
          }),
        }));
        summary.push(`Updated ${changed} element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "setElementText": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (el.kind !== "text" || !ids.has(el.id)) return el;
            changed += 1;
            const text = op.mode === "append" && el.text ? `${el.text}\n${op.text}` : op.text;
            return { ...el, text };
          }),
        }));
        summary.push(`Edited ${changed} text element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "styleElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (el.kind !== "text" || !ids.has(el.id)) return el;
            changed += 1;
            return { ...el, style: { ...el.style, ...op.style } };
          }),
        }));
        summary.push(`Styled ${changed} text element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "updateShapes": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (el.kind !== "shape" || !ids.has(el.id)) return el;
            changed += 1;
            const next = { ...el };
            if (op.shape !== undefined) next.shape = op.shape;
            if (op.strokeWidth !== undefined) next.strokeWidth = op.strokeWidth;
            if (op.fill === null) delete next.fill;
            else if (op.fill !== undefined) next.fill = op.fill;
            if (op.stroke === null) delete next.stroke;
            else if (op.stroke !== undefined) next.stroke = op.stroke;
            return next;
          }),
        }));
        summary.push(`Styled ${changed} shape${changed === 1 ? "" : "s"}`);
        break;
      }

      case "updateImages": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (el.kind !== "image" || !ids.has(el.id)) return el;
            changed += 1;
            const next = { ...el };
            if (op.src !== undefined) next.src = op.src;
            if (op.fit !== undefined) next.fit = op.fit;
            if (op.caption === null) delete next.caption;
            else if (op.caption !== undefined) next.caption = op.caption;
            return next;
          }),
        }));
        summary.push(`Updated ${changed} image${changed === 1 ? "" : "s"}`);
        break;
      }

      case "duplicateElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let made = 0;
        deck = mapTargeted(deck, indexes, (slide) => {
          const copies = slide.elements
            .filter((el) => ids.has(el.id))
            .map((el) => {
              made += 1;
              return {
                ...structuredClone(el),
                id: newId(),
                x: el.x + (op.offsetX ?? 24),
                y: el.y + (op.offsetY ?? 24),
                locked: false,
              };
            });
          return copies.length ? { ...slide, elements: [...slide.elements, ...copies] } : slide;
        });
        summary.push(`Duplicated ${made} element${made === 1 ? "" : "s"}`);
        break;
      }

      case "alignElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => {
          const picked = slide.elements.filter((el) => ids.has(el.id));
          if (picked.length === 0) return slide;
          const left = op.relativeTo === "slide" ? 0 : Math.min(...picked.map((el) => el.x));
          const right = op.relativeTo === "slide" ? SLIDE_W : Math.max(...picked.map((el) => el.x + el.w));
          const top = op.relativeTo === "slide" ? 0 : Math.min(...picked.map((el) => el.y));
          const bottom = op.relativeTo === "slide" ? SLIDE_H : Math.max(...picked.map((el) => el.y + el.h));
          return {
            ...slide,
            elements: slide.elements.map((el) => {
              if (!ids.has(el.id)) return el;
              changed += 1;
              if (op.align === "left") return { ...el, x: left };
              if (op.align === "center") return { ...el, x: (left + right - el.w) / 2 };
              if (op.align === "right") return { ...el, x: right - el.w };
              if (op.align === "top") return { ...el, y: top };
              if (op.align === "middle") return { ...el, y: (top + bottom - el.h) / 2 };
              return { ...el, y: bottom - el.h };
            }),
          };
        });
        summary.push(`Aligned ${changed} element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "distributeElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => {
          const horizontal = op.axis === "horizontal";
          const picked = slide.elements
            .filter((el) => ids.has(el.id))
            .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
          if (picked.length < 3) return slide;
          const first = picked[0]!;
          const last = picked.at(-1)!;
          const start = horizontal ? first.x : first.y;
          const end = horizontal ? last.x + last.w : last.y + last.h;
          const totalSize = picked.reduce((sum, el) => sum + (horizontal ? el.w : el.h), 0);
          const gap = (end - start - totalSize) / (picked.length - 1);
          const positions = new Map<string, number>();
          let cursor = start;
          for (const el of picked) {
            positions.set(el.id, cursor);
            cursor += (horizontal ? el.w : el.h) + gap;
          }
          return {
            ...slide,
            elements: slide.elements.map((el) => {
              const position = positions.get(el.id);
              if (position === undefined) return el;
              changed += 1;
              return horizontal ? { ...el, x: position } : { ...el, y: position };
            }),
          };
        });
        summary.push(`Distributed ${changed} element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "deleteElements": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        const ids = new Set(op.elementIds);
        let removed = 0;
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.filter((el) => {
            const drop = ids.has(el.id);
            if (drop) removed += 1;
            return !drop;
          }),
        }));
        summary.push(`Deleted ${removed} element${removed === 1 ? "" : "s"}`);
        break;
      }

      case "reorderElement": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        let changed = 0;
        deck = mapTargeted(deck, indexes, (slide) => {
          const from = slide.elements.findIndex((el) => el.id === op.elementId);
          if (from === -1) return slide;
          const to =
            op.direction === "front"
              ? slide.elements.length - 1
              : op.direction === "back"
                ? 0
                : op.direction === "forward"
                  ? Math.min(from + 1, slide.elements.length - 1)
                  : Math.max(from - 1, 0);
          if (from === to) return slide;
          const elements = [...slide.elements];
          const [element] = elements.splice(from, 1);
          elements.splice(to, 0, element!);
          changed += 1;
          return { ...slide, elements };
        });
        summary.push(`Reordered ${changed} element${changed === 1 ? "" : "s"}`);
        break;
      }

      case "styleText": {
        const indexes = resolveTarget(deck, op.target, currentSlide);
        deck = mapTargeted(deck, indexes, (slide) => ({
          ...slide,
          elements: slide.elements.map((el) => {
            if (el.kind !== "text") return el;
            if (op.role !== "all" && el.role !== op.role) return el;
            return {
              ...el,
              style: {
                ...el.style,
                ...(op.fontSize !== undefined ? { fontSize: op.fontSize } : {}),
                ...(op.bold !== undefined ? { bold: op.bold } : {}),
                ...(op.italic !== undefined ? { italic: op.italic } : {}),
                ...(op.underline !== undefined ? { underline: op.underline } : {}),
                ...(op.align !== undefined ? { align: op.align } : {}),
                ...(op.color !== undefined ? { color: op.color } : {}),
              },
            };
          }),
        }));
        summary.push(`Styled text on ${indexes.length} slide${indexes.length === 1 ? "" : "s"}`);
        break;
      }
    }
  }

  return { deck, summary };
}

/**
 * Dry run for the preview: apply to a copy and validate. Returns the error
 * instead of the deck when the result wouldn't survive `Deck` — most likely
 * the forward-cue rule, which a plausible instruction can genuinely violate.
 */
export function validateOps(
  deck: Deck,
  ops: readonly Op[],
  currentSlide = 0,
): { ok: true; result: ApplyResult } | { ok: false; error: string } {
  let result: ApplyResult;
  try {
    result = applyOps(deck, ops, currentSlide);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const parsed = Deck.safeParse(result.deck);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "the result would not be a valid deck" };
  }
  return { ok: true, result: { deck: parsed.data, summary: result.summary } };
}
