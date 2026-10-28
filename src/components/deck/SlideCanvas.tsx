import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SLIDE_H, SLIDE_W, type SlideElement } from "../../schema/deck.js";
import {
  GRID_SIZE,
  elementsInRect,
  normalizeRect,
  snapFrame,
  snapTargets,
  snapToGrid,
  boundsOf,
  type Frame,
} from "../../deck/geometry.js";
import { useDeckStore } from "../../store/deckStore.js";
import { JUSTIFY, TAB_FONT_STACK, SlideRenderer, elementStyle, imagePathsOf } from "./SlideRenderer.js";
import { CanvasContextMenu, type MenuPoint } from "./CanvasContextMenu.js";
import { useDeckAssets } from "./useDeckAssets.js";

/**
 * The editing surface.
 *
 * All geometry is computed in slide units (1280x720) and only converted to
 * screen pixels at the very edge, by dividing pointer deltas by `scale`.
 * Doing it the other way round — tracking positions in screen pixels — makes
 * every drag depend on the current zoom and quietly corrupts coordinates when
 * the window resizes mid-gesture.
 *
 * Interaction mirrors Impress: click selects, Shift+click extends, a drag on
 * empty space rubber-bands, handles resize, the detached handle above the
 * selection rotates, and Alt suspends snapping for one gesture.
 */

type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SIZE = 24;
/** How far above the selection the rotation handle sits, in slide units. */
const ROTATE_ARM = 36;

/**
 * Bend amounts offered while editing a tab, as a bare number, never a
 * spelled-out word — `1/2` for a half-step bend, `1` for a whole step,
 * `1 1/2` for a step and a half. Deliberately no "b" prefix: "b" already
 * means *flat* in this app (Bb, Eb, the tuning labels themselves), so
 * reusing it for "bend" would make the same letter mean two different
 * things in the same line of text. Reference notation, not an inferred
 * value; the user picks one and it's inserted verbatim at the caret.
 */
const BEND_MARKS: Array<{ glyph: string; snippet: string; title: string }> = [
  { glyph: "½", snippet: "1/2", title: "Half-step bend (1/2)" },
  { glyph: "1", snippet: "1", title: "Whole-step bend (1)" },
  { glyph: "1½", snippet: "1 1/2", title: "Step-and-a-half bend (1 1/2)" },
];

const GESTURE_ENDS = ["pointerup", "pointercancel", "blur"] as const;

/**
 * Runs one pointer gesture: `onMove` until the pointer is released, the browser cancels it, or the window loses it,
 * then `onEnd` once. Text selection is suppressed page-wide for the gesture only — a standing select-none would also
 * stop selecting text inside the inline editor — and every way a gesture ends releases it, so none can strand it.
 */
export function trackGesture(
  onMove: (ev: PointerEvent) => void,
  onEnd: () => void = () => {},
  target: EventTarget = window,
  root: { classList: { add(token: string): void; remove(token: string): void } } = document.documentElement,
) {
  root.classList.add("select-none");
  const move = onMove as EventListener;
  const end = () => {
    root.classList.remove("select-none");
    target.removeEventListener("pointermove", move);
    for (const type of GESTURE_ENDS) target.removeEventListener(type, end);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  for (const type of GESTURE_ENDS) target.addEventListener(type, end);
}

function handlePosition(h: Handle): { x: number; y: number } {
  return {
    x: h.includes("w") ? 0 : h.includes("e") ? 1 : 0.5,
    y: h.includes("n") ? 0 : h.includes("s") ? 1 : 0.5,
  };
}

function resize(el: SlideElement, h: Handle, dx: number, dy: number) {
  let { x, y, w, h: height } = el;
  if (h.includes("w")) {
    const nw = Math.max(MIN_SIZE, w - dx);
    x += w - nw;
    w = nw;
  }
  if (h.includes("e")) w = Math.max(MIN_SIZE, w + dx);
  if (h.includes("n")) {
    const nh = Math.max(MIN_SIZE, height - dy);
    y += height - nh;
    height = nh;
  }
  if (h.includes("s")) height = Math.max(MIN_SIZE, height + dy);
  return { x, y, w, h: height };
}

export function SlideCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The slide's screen box, for turning pointer positions into slide units. */
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(0.5);
  /** Rubber-band rectangle in slide units, while one is being dragged. */
  const [marquee, setMarquee] = useState<Frame | null>(null);
  /** Guide lines that matched during the current drag, for feedback. */
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [menu, setMenu] = useState<MenuPoint | null>(null);

  const deck = useDeckStore((s) => s.deck);
  const currentSlide = useDeckStore((s) => s.currentSlide);
  const selectedIds = useDeckStore((s) => s.selectedElementIds);
  const editingId = useDeckStore((s) => s.editingElementId);
  const zoom = useDeckStore((s) => s.zoom);
  const showGrid = useDeckStore((s) => s.showGrid);
  const snapEnabled = useDeckStore((s) => s.snapEnabled);

  const selectElement = useDeckStore((s) => s.selectElement);
  const toggleElementSelection = useDeckStore((s) => s.toggleElementSelection);
  const selectElements = useDeckStore((s) => s.selectElements);
  const selectAllElements = useDeckStore((s) => s.selectAllElements);
  const setEditingElement = useDeckStore((s) => s.setEditingElement);
  const updateElement = useDeckStore((s) => s.updateElement);
  const updateSelection = useDeckStore((s) => s.updateSelection);
  const nudgeSelection = useDeckStore((s) => s.nudgeSelection);
  const deleteSelection = useDeckStore((s) => s.deleteSelection);
  const copySelection = useDeckStore((s) => s.copySelection);
  const cutSelection = useDeckStore((s) => s.cutSelection);
  const pasteClipboard = useDeckStore((s) => s.pasteClipboard);
  const duplicateSelection = useDeckStore((s) => s.duplicateSelection);
  const arrangeSelection = useDeckStore((s) => s.arrangeSelection);

  const slide = deck?.slides[currentSlide] ?? null;
  const assetUrls = useDeckAssets(imagePathsOf(slide ? [slide] : [], deck?.theme));
  const scale = zoom === "fit" ? fitScale : zoom;
  const editing = slide?.elements.find((el) => el.id === editingId);

  // The inline editor's height tracks its content, so `valign` applies while
  // typing. Measured from `scrollHeight` after a reset to `auto` — the only
  // way to learn a textarea's natural height, and it must re-run on every
  // keystroke or the box lags a line behind what has been typed.
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [editorHeight, setEditorHeight] = useState<number | "auto">("auto");
  /**
   * A tab's natural width, measured the same way as height — needed because
   * tab lines never wrap (`white-space: pre`; wrapping would misalign the
   * string grid), so a line longer than the box was invisible *and*
   * unreachable by mouse, with no scrollbar to reach it either. Left "auto"
   * for text, which already handles overflow by wrapping within its box.
   */
  const [editorWidth, setEditorWidth] = useState<number | "auto">("auto");
  /** Cursor position to restore after a programmatic insert (see `insertBend`). */
  const pendingCursor = useRef<number | null>(null);
  /**
   * Wraps the whole bend palette (presets + the custom-amount field), so the
   * main textarea's blur handler can tell "focus moved into the palette"
   * (keep editing open) from "focus left the editor entirely" (close it).
   * Needed because the custom field, unlike the preset buttons, is meant to
   * actually take focus — a plain `preventDefault` trick would block typing.
   */
  const bendPaletteRef = useRef<HTMLDivElement>(null);
  const [customBend, setCustomBend] = useState("");
  useLayoutEffect(() => {
    const field = editorRef.current;
    if (!field) return;
    field.style.height = "auto";
    setEditorHeight(field.scrollHeight);
    if (editing?.kind === "tab") {
      // `scrollWidth` on its own can't shrink back down once the box has
      // grown — with the old width still applied, short content never
      // overflows, so it just reports that old width back. Collapsing first
      // (as already done for height, above) is what lets it re-measure the
      // *current* content's true natural width, in either direction.
      field.style.width = "1px";
      setEditorWidth(field.scrollWidth);
    }
    // Only set by `insertBend`. Plain typing leaves this null and the browser
    // manages the caret itself; a programmatic text change would otherwise
    // reset it to the end, right after whatever was just inserted.
    if (pendingCursor.current !== null) {
      const pos = pendingCursor.current;
      pendingCursor.current = null;
      field.focus();
      field.setSelectionRange(pos, pos);
    }
  }, [
    editing?.kind === "text" || editing?.kind === "tab" ? editing.text : null,
    editing?.kind,
    editingId,
    scale,
  ]);

  /**
   * The wrapper's on-screen size while growing to fit content — capped at
   * the slide's own edge (`SLIDE_H`/`SLIDE_W`), not just at whatever the
   * content needs. The box lives inside `SlideRenderer`'s clipped 1280×720
   * container, so growing past the slide's edge doesn't make more content
   * visible, it just moves the clipping boundary from "the box" to "the
   * slide" — same bug, one edge further out.
   *
   * Deliberately the *only* thing capped here. The textarea inside keeps its
   * own natural, uncapped size (see its `height`/`width` below) — that's
   * what gives the wrapper's `overflow: auto` something to scroll once the
   * cap is actually hit, and it's also what lets `valign` keep working:
   * shorter content needs a shorter textarea for `justifyContent` to
   * position within the wrapper, not one stretched to match it.
   */
  const editorBoxHeight =
    editing?.kind === "text" || editing?.kind === "tab"
      ? Math.min(
          Math.max(0, SLIDE_H - editing.y),
          Math.max(editing.h, typeof editorHeight === "number" ? editorHeight : 0),
        )
      : 0;
  const editorBoxWidth =
    editing?.kind === "tab" && typeof editorWidth === "number"
      ? Math.min(Math.max(0, SLIDE_W - editing.x), Math.max(editing.w, editorWidth))
      : null;

  /**
   * Splices a bend marker into the tab text at the caret (replacing any
   * selection) — the bend amount as a bare number, never spelled out and
   * never "b"-prefixed: `1/2`, `1`, `1 1/2`. See `BEND_MARKS` for why no "b".
   */
  function insertBend(snippet: string) {
    if (editing?.kind !== "tab") return;
    const field = editorRef.current;
    const start = field?.selectionStart ?? editing.text.length;
    const end = field?.selectionEnd ?? editing.text.length;
    const next = editing.text.slice(0, start) + snippet + editing.text.slice(end);
    pendingCursor.current = start + snippet.length;
    updateElement(editing.id, (el) => (el.kind === "tab" ? { ...el, text: next } : el));
  }

  // NOT a selector: `filter` builds a fresh array, which Zustand would see as
  // a change on every render and spin on until React blanks the panel.
  const selected = useMemo(
    () => (slide?.elements ?? []).filter((el) => selectedIds.includes(el.id)),
    [slide, selectedIds],
  );
  const selectionBounds = useMemo(() => boundsOf(selected), [selected]);

  // Fit the slide to the available box, leaving a small margin. Still measured
  // while zoomed, so switching back to "fit" is instant and correct.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const next = Math.min((width - 48) / SLIDE_W, (height - 48) / SLIDE_H);
      setFitScale(Math.max(0.05, next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Keyboard: Impress's editing shortcuts. Skipped while typing in a field so
  // Delete edits text instead of destroying the element being edited.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (e.key === "Escape") {
        setEditingElement(null);
        selectElement(null);
        setMenu(null);
        return;
      }
      if (typing) return;

      const accel = e.ctrlKey || e.metaKey;
      if (accel) {
        const key = e.key.toLowerCase();
        // Undo/redo stay with the toolbar's own handler; everything here is
        // selection-based and would otherwise need repeating per component.
        const commands: Record<string, () => void> = {
          a: selectAllElements,
          c: copySelection,
          x: cutSelection,
          v: pasteClipboard,
          d: duplicateSelection,
        };
        const run = commands[key];
        if (run) {
          e.preventDefault();
          run();
          return;
        }
        // Ctrl+Shift+Arrow — Impress's Arrange. Plain Ctrl+Arrow is left for
        // the browser's word-wise caret movement.
        if (e.shiftKey && selectedIds.length > 0) {
          const arrange = {
            ArrowUp: "forward",
            ArrowDown: "backward",
            Home: "front",
            End: "back",
          } as const;
          const direction = arrange[e.key as keyof typeof arrange];
          if (direction) {
            e.preventDefault();
            arrangeSelection(direction);
            return;
          }
        }
      }

      if (selectedIds.length === 0) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      // Shift is the coarse step, as in Impress; the fine step is one grid
      // subdivision so nudging still lands on grid positions.
      const step = e.shiftKey ? GRID_SIZE : 2;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = nudge[e.key];
      if (delta) {
        e.preventDefault();
        nudgeSelection(delta[0], delta[1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedIds,
    selectElement,
    selectAllElements,
    setEditingElement,
    deleteSelection,
    nudgeSelection,
    copySelection,
    cutSelection,
    pasteClipboard,
    duplicateSelection,
    arrangeSelection,
  ]);

  /** Pointer position in slide units, from a client-space event. */
  function toSlide(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  }

  function startDrag(e: React.PointerEvent, el: SlideElement, handle: Handle | null) {
    if (el.locked || editingId === el.id) return;
    e.stopPropagation();
    e.preventDefault();
    setMenu(null);

    // Shift/Ctrl extends the selection instead of replacing it. Clicking an
    // element that is already part of a multi-selection keeps the group, so a
    // group can be dragged without first losing it.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      toggleElementSelection(el.id);
      return;
    }
    const ids = selectedIds.includes(el.id) ? selectedIds : [el.id];
    if (!selectedIds.includes(el.id)) selectElement(el.id);

    const startX = e.clientX;
    const startY = e.clientY;
    const moving = (slide?.elements ?? []).filter((m) => ids.includes(m.id) && !m.locked);
    const origins = new Map(moving.map((m) => [m.id, { x: m.x, y: m.y, w: m.w, h: m.h }]));
    const others = (slide?.elements ?? []).filter((m) => !ids.includes(m.id));
    const targets = snapTargets(others);
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      let dx = (ev.clientX - startX) / scale;
      let dy = (ev.clientY - startY) / scale;
      // Alt suspends snapping for the gesture — the escape hatch that makes an
      // otherwise-helpful magnet tolerable when placing something deliberately.
      const snapping = snapEnabled && !ev.altKey;

      if (handle) {
        const el0 = origins.get(el.id);
        if (!el0) return;
        updateElement(el.id, (current) => {
          const next = resize({ ...current, ...el0 }, handle, dx, dy);
          if (!snapping) return { ...current, ...next };
          const hit = snapFrame(next, targets);
          // Resizing moves the dragged edge, so the snap is applied as a size
          // change on that edge rather than by shifting the whole frame.
          const snapped = { ...next };
          if (handle.includes("e")) snapped.w = Math.max(MIN_SIZE, hit.x + next.w - next.x);
          else if (handle.includes("w")) {
            snapped.w = Math.max(MIN_SIZE, next.w + (next.x - hit.x));
            snapped.x = hit.x;
          }
          if (handle.includes("s")) snapped.h = Math.max(MIN_SIZE, hit.y + next.h - next.y);
          else if (handle.includes("n")) {
            snapped.h = Math.max(MIN_SIZE, next.h + (next.y - hit.y));
            snapped.y = hit.y;
          }
          setGuides(hit.guides);
          return { ...current, ...snapped };
        });
        return;
      }

      // Snapping is resolved once, against the selection's bounding box, and
      // the resulting correction is applied to every member — so a group moves
      // rigidly instead of each element latching onto its own guide.
      if (snapping && selectionBounds) {
        const hit = snapFrame(
          { x: selectionBounds.x + dx, y: selectionBounds.y + dy, w: selectionBounds.w, h: selectionBounds.h },
          targets,
        );
        dx += hit.x - (selectionBounds.x + dx);
        dy += hit.y - (selectionBounds.y + dy);
        setGuides(hit.guides);
      } else {
        setGuides({ x: [], y: [] });
      }

      updateSelection((current) => {
        const origin = origins.get(current.id);
        return origin ? { ...current, x: origin.x + dx, y: origin.y + dy } : current;
      });
    };
    trackGesture(onMove, () => setGuides({ x: [], y: [] }));
  }

  /** The detached handle above the selection, as in Impress's rotate mode. */
  function startRotate(e: React.PointerEvent) {
    if (!selectionBounds) return;
    e.stopPropagation();
    e.preventDefault();
    const centre = {
      x: selectionBounds.x + selectionBounds.w / 2,
      y: selectionBounds.y + selectionBounds.h / 2,
    };
    const origins = new Map(selected.map((el) => [el.id, el.rotation]));
    const startPoint = toSlide(e);
    if (!startPoint) return;
    const startAngle = Math.atan2(startPoint.y - centre.y, startPoint.x - centre.x);

    const onMove = (ev: PointerEvent) => {
      const point = toSlide(ev);
      if (!point) return;
      const angle = Math.atan2(point.y - centre.y, point.x - centre.x);
      let degrees = ((angle - startAngle) * 180) / Math.PI;
      // Shift constrains to 15°, matching Impress — the difference between
      // "roughly diagonal" and a clean 45.
      if (ev.shiftKey) degrees = Math.round(degrees / 15) * 15;
      updateSelection((el) => {
        const origin = origins.get(el.id);
        return origin === undefined || el.locked
          ? el
          : { ...el, rotation: Math.round(origin + degrees) };
      });
    };
    trackGesture(onMove);
  }

  /** Rubber-band selection, started on empty canvas. */
  function startMarquee(e: React.PointerEvent) {
    setMenu(null);
    const start = toSlide(e);
    if (!start || !slide) {
      selectElement(null);
      setEditingElement(null);
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? [...selectedIds] : [];
    if (!additive) {
      selectElement(null);
      setEditingElement(null);
    }

    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const point = toSlide(ev);
      if (!point) return;
      moved = true;
      const rect = normalizeRect(start.x, start.y, point.x, point.y);
      setMarquee(rect);
      const inside = elementsInRect(slide.elements, rect).map((el) => el.id);
      selectElements([...new Set([...base, ...inside])]);
    };
    trackGesture(onMove, () => {
      setMarquee(null);
      // A click with no drag is just "deselect", already done above.
      if (!moved && additive) selectElements(base);
    });
  }

  if (!deck) return null;

  const gridLines = showGrid
    ? {
        x: Array.from({ length: Math.floor(SLIDE_W / GRID_SIZE) + 1 }, (_, i) => i * GRID_SIZE),
        y: Array.from({ length: Math.floor(SLIDE_H / GRID_SIZE) + 1 }, (_, i) => i * GRID_SIZE),
      }
    : null;

  return (
    <div
      ref={wrapRef}
      className="relative flex flex-1 items-center justify-center overflow-auto bg-neutral-800/60 p-6"
      onPointerDown={startMarquee}
      onContextMenu={(e) => {
        e.preventDefault();
        // Right-clicking an unselected element selects it first, so the menu's
        // commands act on what the user pointed at.
        const point = toSlide(e);
        const hit = point
          ? [...(slide?.elements ?? [])]
              .reverse()
              .find(
                (el) =>
                  point.x >= el.x &&
                  point.x <= el.x + el.w &&
                  point.y >= el.y &&
                  point.y <= el.y + el.h,
              )
          : undefined;
        if (hit && !selectedIds.includes(hit.id)) selectElement(hit.id);
        if (!hit) selectElement(null);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {slide ? (
        <SlideRenderer
          slide={slide}
          theme={deck.theme}
          scale={scale}
          assetUrls={assetUrls}
          className="shadow-2xl ring-1 ring-black/40"
          surfaceRef={surfaceRef}
          // The element being edited is drawn by the inline field below, not
          // by the renderer — otherwise its text shows through and doubles.
          hiddenElementIds={editingId ? [editingId] : undefined}
        >
          {/* Grid, beneath everything interactive. */}
          {gridLines && (
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {gridLines.x.map((x) => (
                <div
                  key={`gx-${x}`}
                  style={{
                    position: "absolute",
                    left: x,
                    top: 0,
                    width: Math.max(1 / scale, 0.5),
                    height: SLIDE_H,
                    background: x % (GRID_SIZE * 4) === 0 ? "#38bdf833" : "#94a3b81f",
                  }}
                />
              ))}
              {gridLines.y.map((y) => (
                <div
                  key={`gy-${y}`}
                  style={{
                    position: "absolute",
                    top: y,
                    left: 0,
                    height: Math.max(1 / scale, 0.5),
                    width: SLIDE_W,
                    background: y % (GRID_SIZE * 4) === 0 ? "#38bdf833" : "#94a3b81f",
                  }}
                />
              ))}
            </div>
          )}

          {/* Interaction layer, in slide coordinates. */}
          {slide.elements.map((el) => (
            <div
              key={`hit-${el.id}`}
              onPointerDown={(e) => startDrag(e, el, null)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if ((el.kind === "text" || el.kind === "tab") && !el.locked) {
                  setEditingElement(el.id);
                }
              }}
              style={{
                ...elementStyle(el),
                cursor: el.locked ? "not-allowed" : "move",
                outline: selectedIds.includes(el.id)
                  ? `${2 / scale}px solid #38bdf8`
                  : `${1 / scale}px dashed transparent`,
                outlineOffset: 0,
                background: "transparent",
              }}
            />
          ))}

          {/* Snap guides, drawn only for the lines that actually matched. */}
          {guides.x.map((x) => (
            <div
              key={`sx-${x}`}
              style={{
                position: "absolute",
                left: x,
                top: 0,
                width: Math.max(1 / scale, 0.5),
                height: SLIDE_H,
                background: "#f472b6",
                pointerEvents: "none",
              }}
            />
          ))}
          {guides.y.map((y) => (
            <div
              key={`sy-${y}`}
              style={{
                position: "absolute",
                top: y,
                left: 0,
                height: Math.max(1 / scale, 0.5),
                width: SLIDE_W,
                background: "#f472b6",
                pointerEvents: "none",
              }}
            />
          ))}

          {/* Marquee. */}
          {marquee && (
            <div
              style={{
                position: "absolute",
                left: marquee.x,
                top: marquee.y,
                width: marquee.w,
                height: marquee.h,
                border: `${1 / scale}px dashed #38bdf8`,
                background: "#38bdf81a",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Multi-selection outline: the box the group's commands act on. */}
          {selected.length > 1 && selectionBounds && (
            <div
              style={{
                position: "absolute",
                left: selectionBounds.x,
                top: selectionBounds.y,
                width: selectionBounds.w,
                height: selectionBounds.h,
                border: `${1 / scale}px dashed #7dd3fc`,
                pointerEvents: "none",
              }}
            />
          )}

          {/* Resize handles — one element only. A multi-selection resizes by
              its own rules in Impress, which we don't implement, so offering
              handles that silently resize only one member would mislead. */}
          {selected.length === 1 &&
            selected
              .filter((el) => !el.locked)
              .map((el) =>
                HANDLES.map((h) => {
                  const pos = handlePosition(h);
                  const size = 10 / scale;
                  return (
                    <div
                      key={`${el.id}-${h}`}
                      onPointerDown={(e) => startDrag(e, el, h)}
                      style={{
                        position: "absolute",
                        left: el.x + el.w * pos.x - size / 2,
                        top: el.y + el.h * pos.y - size / 2,
                        width: size,
                        height: size,
                        background: "#38bdf8",
                        border: `${1 / scale}px solid #0c4a6e`,
                        cursor: `${h}-resize`,
                      }}
                    />
                  );
                }),
              )}

          {/* Rotation handle, detached above the selection. */}
          {selectionBounds && selected.some((el) => !el.locked) && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: selectionBounds.x + selectionBounds.w / 2,
                  top: selectionBounds.y - ROTATE_ARM,
                  width: Math.max(1 / scale, 0.5),
                  height: ROTATE_ARM,
                  background: "#38bdf8",
                  pointerEvents: "none",
                }}
              />
              <div
                title="Drag to rotate (Shift for 15° steps)"
                onPointerDown={startRotate}
                style={{
                  position: "absolute",
                  left: selectionBounds.x + selectionBounds.w / 2 - 7 / scale,
                  top: selectionBounds.y - ROTATE_ARM - 14 / scale,
                  width: 14 / scale,
                  height: 14 / scale,
                  borderRadius: "50%",
                  background: "#0ea5e9",
                  border: `${1 / scale}px solid #0c4a6e`,
                  cursor: "grab",
                }}
              />
            </>
          )}

          {/* Inline editing, for text and tab elements alike.
              The element itself is hidden while this is up (`hiddenElementIds`)
              — the field is opaque only in tint, so leaving the element drawn
              underneath showed every character twice.
              Everything here mirrors `ElementView`'s branch for the same kind,
              so what you type sits exactly where it will land: same
              typography, same wrapping, same vertical alignment. The
              selection ring is an `outline`, which paints outside the box and
              so cannot shift the text the way a border would. */}
          {(editing?.kind === "text" || editing?.kind === "tab") && (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                ...elementStyle(editing),
                display: "flex",
                flexDirection: "column",
                justifyContent: JUSTIFY[editing.style.valign],
                background: "#38bdf822",
                outline: `${2 / scale}px solid #38bdf8`,
                // Grows to fit what's being typed instead of staying clamped
                // to the element's saved height — otherwise a short box (the
                // default text frame is 120 units tall) clips everything past
                // the first line or two while you're actively editing, even
                // though the text you typed is all still there. Reverts to
                // its real, fixed size the instant editing ends; this is a
                // while-editing affordance, not a resize. See `editorBoxHeight`
                // for why it's capped rather than growing without limit.
                height: editorBoxHeight,
                // "auto", not "hidden": once content needs more room than the
                // cap allows, this is what makes the rest reachable — a plain
                // scrollbar — instead of just clipping it a second time. A
                // no-op whenever content already fits (the common case).
                overflow: "auto",
                ...(editorBoxWidth !== null ? { width: editorBoxWidth } : {}),
              }}
            >
              <textarea
                autoFocus
                ref={editorRef}
                value={editing.text}
                onChange={(e) => {
                  const value = e.target.value;
                  updateElement(editing.id, (el) =>
                    el.kind === editing.kind ? { ...el, text: value } : el,
                  );
                }}
                onBlur={(e) => {
                  // Clicking into the custom-amount field moves focus there
                  // deliberately — that must not read as "done editing".
                  if (bendPaletteRef.current?.contains(e.relatedTarget as Node | null)) return;
                  setEditingElement(null);
                }}
                style={{
                  // Own natural, uncapped size — deliberately *not* the
                  // (possibly slide-edge-capped) `editorBoxHeight`/
                  // `editorBoxWidth`. Staying at its true size, even when
                  // that's bigger than the capped wrapper around it, is what
                  // gives the wrapper's `overflow: auto` something to scroll;
                  // and staying at its true size when that's *smaller* than
                  // the wrapper is what leaves `valign` room to position it.
                  height: editorHeight,
                  width:
                    editing.kind === "tab" && typeof editorWidth === "number"
                      ? Math.max(editing.w, editorWidth)
                      : "100%",
                  overflow: "hidden",
                  fontSize: editing.style.fontSize,
                  color: editing.style.color ?? deck.theme.text,
                  lineHeight: editing.style.lineHeight,
                  boxSizing: "border-box",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  padding: 0,
                  margin: 0,
                  ...(editing.kind === "tab"
                    ? // No bold/italic/align here on purpose — see TabStyle:
                      // they all break the monospace grid a tab depends on.
                      { fontFamily: TAB_FONT_STACK, whiteSpace: "pre" as const }
                    : {
                        fontWeight: editing.style.bold ? 700 : 400,
                        fontStyle: editing.style.italic ? "italic" : "normal",
                        textDecoration: editing.style.underline ? "underline" : "none",
                        textAlign: editing.style.align,
                        fontFamily: editing.style.fontFamily ?? deck.theme.fontFamily,
                        whiteSpace: "pre-wrap" as const,
                        wordBreak: "break-word" as const,
                      }),
                }}
              />
            </div>
          )}

          {/* Placeholder hints — only while empty, and never in presentation. */}
          {slide.elements
            .filter(
              (el): el is Extract<SlideElement, { kind: "text" | "tab" }> =>
                (el.kind === "text" || el.kind === "tab") && el.text === "" && el.id !== editingId,
            )
            .map((el) => (
              <div
                key={`ph-${el.id}`}
                style={{
                  ...elementStyle(el),
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  border: `${2 / scale}px dashed ${deck.theme.text}33`,
                  color: `${deck.theme.text}66`,
                  fontSize: 24,
                  fontFamily: el.kind === "tab" ? TAB_FONT_STACK : deck.theme.fontFamily,
                }}
              >
                {el.kind === "tab"
                  ? "Double-click to add tab"
                  : el.role === "title"
                    ? "Double-click to add title"
                    : "Double-click to add text"}
              </div>
            ))}
        </SlideRenderer>
      ) : (
        <p className="text-sm text-neutral-500">
          This deck has no slides yet — add one from the panel on the left.
        </p>
      )}

      {menu && <CanvasContextMenu at={menu} onClose={() => setMenu(null)} />}

      {/* Bend-insert palette, only while actively editing a tab — inserting
          needs the caret position, which only exists while the textarea is
          focused. Fixed in a corner of the canvas rather than tracked to the
          element itself: the element can be rotated and scaled by the zoom
          level, and an unscaled, unrotated toolbar is what stays usable. */}
      {editing?.kind === "tab" && (
        <div
          ref={bendPaletteRef}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-2 right-3 flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900/95 px-1.5 py-1 shadow-lg"
        >
          <span className="pr-1 text-[10px] text-neutral-500">Bend</span>
          {BEND_MARKS.map(({ glyph, snippet, title }) => (
            <button
              key={snippet}
              type="button"
              title={title}
              aria-label={title}
              // Keeps focus (and the selection range) on the textarea, so the
              // click handler reads where the caret actually was rather than
              // "end of text" after a blur.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertBend(snippet)}
              className="min-w-[1.75rem] rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700"
            >
              {glyph}
            </button>
          ))}

          <span className="mx-0.5 h-4 w-px bg-neutral-700" />

          {/* Any amount, not just the three presets — typed verbatim, same as
              everywhere else in the app. This field is meant to take focus
              (you're typing into it), so the textarea's blur handler is what
              keeps the editor open, not a preventDefault trick here. */}
          <input
            type="text"
            inputMode="text"
            value={customBend}
            onChange={(e) => setCustomBend(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const amount = customBend.trim();
              if (!amount) return;
              insertBend(amount);
              setCustomBend("");
            }}
            placeholder="amt"
            title='Any bend amount, e.g. "1/4" or "2" — Enter to insert'
            aria-label="Bend amount"
            className="w-12 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <button
            type="button"
            title="Insert this amount at the cursor"
            aria-label="Insert bend amount"
            disabled={customBend.trim() === ""}
            onClick={() => {
              const amount = customBend.trim();
              if (!amount) return;
              insertBend(amount);
              setCustomBend("");
            }}
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800"
          >
            +
          </button>
        </div>
      )}

      {/* Status readout, like Impress's status bar. */}
      <div className="pointer-events-none absolute bottom-2 left-3 flex gap-3 text-[10px] text-neutral-500">
        <span>{Math.round(scale * 100)}%</span>
        {selected.length > 0 && (
          <span>
            {selected.length} selected
            {selectionBounds &&
              ` · ${Math.round(selectionBounds.x)},${Math.round(selectionBounds.y)} · ${Math.round(
                selectionBounds.w,
              )}×${Math.round(selectionBounds.h)}`}
          </span>
        )}
        {snapEnabled && <span>snap {showGrid ? `· grid ${snapToGrid(GRID_SIZE)}` : "on"}</span>}
      </div>
    </div>
  );
}
