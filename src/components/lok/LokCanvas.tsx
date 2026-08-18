import { useEffect, useRef, useState } from "react";
import { parseSelectionRect, pxToTwips, twipsRectToPx, type TwipsRect } from "../../lok/geometry.js";
import { connectEvents, postInput, postRender, slideUrl, type LokEvent } from "../../lok/client.js";

/**
 * The LOK-backed editing surface — Stage 2. Displays the server-rendered
 * tile and forwards raw pointer/keyboard input to the real LibreOffice
 * document, same as any LOK client (Collabora Online included). There is no
 * client-side editing model here at all: every visible change is a round
 * trip through the host and back as a fresh PNG. That is slower than the
 * existing app's DOM-based `SlideRenderer`/`SlideCanvas` and is the deliberate
 * trade this whole pivot is making — see LOK_CAPABILITY_MATRIX.md.
 *
 * Character input and double-click-to-edit-text are PROVEN (Stage 0/1, pixel
 * and event verified against real LibreOffice). Backspace/Delete/Enter/Arrow
 * keys use `com.sun.star.awt.Key` values that are NOT probe-verified the same
 * way — see the AWT_KEYCODE comment below. Escape deliberately does not use a
 * raw key at all: it calls the proven `.uno:Escape` command instead.
 */

// Coordinates and click semantics are in LOK's document space (twips), never
// pixels — see src/lok/geometry.ts's module comment for why the conversion
// happens once, at this component's edge, and nowhere else.

/** com.sun.star.awt.Key constants for the handful of non-printable keys this
 *  editor needs. NOT from memory: queried directly off this machine's
 *  installed LibreOffice 24.2 via `python3-uno` —
 *    python3 -c "from com.sun.star.awt.Key import *; print(LEFT, HOME, ...)"
 *  — after an initial hand-recalled guess got Backspace/Delete/Enter/Tab
 *  right by luck but Left/Up/Right/Down/Home/End/PageUp/PageDown wrong in a
 *  completely different numeric range (1287-1296 guessed vs 1024-1031
 *  actual). Each value below was then re-verified the same way Stage 0
 *  verified everything else: type text, press the key, read the rendered
 *  PNG (see the Stage 2 report for the ArrowLeft before/after screenshots).
 *  If a future LibreOffice version ever changes these, the same one-line
 *  python3-uno query re-derives them — there is no reason to guess again. */
const AWT_KEYCODE: Record<string, number> = {
  Backspace: 1283,
  Delete: 1286,
  Enter: 1280,
  Tab: 1282,
  ArrowLeft: 1026,
  ArrowUp: 1025,
  ArrowRight: 1027,
  ArrowDown: 1024,
  Home: 1028,
  End: 1029,
  PageUp: 1030,
  PageDown: 1031,
};

/** Minimum gap between forwarded MOUSE MOVE events during a drag — LOK gets
 *  the gesture's shape without a flood of HTTP calls on every pixel. */
const MOVE_THROTTLE_MS = 40;
/** Debounce before re-rendering after the last keystroke/gesture — typing
 *  "hello" re-renders once, not five times. */
const RERENDER_DEBOUNCE_MS = 250;

export interface LokCanvasProps {
  slideIndex: number;
  /** Document size in TWIPS, from `/api/project`'s `docSizeTwips` — distinct
   *  from `slideSize`, which is the PNG's render pixel size. Mixing the two
   *  up produces coordinates off by roughly a factor of 12 (1 twip = 1/20pt,
   *  1280px at 96dpi is nowhere near 15875 twips), which is exactly the kind
   *  of bug that "looks fine" until someone clicks somewhere specific. */
  docSize: { w: number; h: number };
  revision: number;
  onRevisionChange: (revision: number) => void;
}

export function LokCanvas({ slideIndex, docSize, revision, onRevisionChange }: LokCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<TwipsRect | null>(null);
  const [renderSize, setRenderSize] = useState({ w: 1280, h: 720 });
  const draggingRef = useRef(false);
  const lastMoveRef = useRef(0);
  const rerenderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the canvas's actual on-screen size — CSS may scale the 1280x720
  // render to fit its container, and pointer coordinates arrive in on-screen
  // pixels, so the conversion has to use that size, not the PNG's intrinsic
  // resolution (same reasoning as SlideRenderer's `scale` prop elsewhere in
  // this app, one level lower).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setRenderSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live selection overlay from the WebSocket event channel — connects once
  // per mount, independent of which slide is showing (events are only
  // meaningful for whatever's currently open on the host, i.e. this slide).
  useEffect(() => {
    setSelection(null);
    const onEvent = (evt: LokEvent) => {
      if (evt.type === "GRAPHIC_SELECTION" || evt.type === "TEXT_SELECTION") {
        setSelection(parseSelectionRect(evt.payload));
      }
    };
    const ws = connectEvents(onEvent);
    return () => ws.close();
  }, [slideIndex]);

  function scale() {
    return { docW: docSize.w, docH: docSize.h, renderW: renderSize.w, renderH: renderSize.h };
  }

  function scheduleRerender() {
    if (rerenderTimer.current) clearTimeout(rerenderTimer.current);
    rerenderTimer.current = setTimeout(() => {
      void postRender(slideIndex).then((r) => onRevisionChange(r.revision));
    }, RERENDER_DEBOUNCE_MS);
  }

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    containerRef.current?.focus();
    const rect = containerRef.current!.getBoundingClientRect();
    const twips = pxToTwips({ x: e.clientX - rect.left, y: e.clientY - rect.top }, scale());
    draggingRef.current = true;
    // e.detail is the DOM's own click-count tracking (1 = single, 2 = double,
    // …) — exactly the semantics postMouseEvent's `count` expects, so it is
    // forwarded directly rather than reimplemented.
    void postInput({ kind: "mouse", type: "DOWN", x: twips.x, y: twips.y, count: e.detail, buttons: 1, modifier: 0 });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!draggingRef.current) return;
    const now = performance.now();
    if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
    lastMoveRef.current = now;
    const rect = containerRef.current!.getBoundingClientRect();
    const twips = pxToTwips({ x: e.clientX - rect.left, y: e.clientY - rect.top }, scale());
    void postInput({ kind: "mouse", type: "MOVE", x: twips.x, y: twips.y, count: 1, buttons: 1, modifier: 0 });
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const rect = containerRef.current!.getBoundingClientRect();
    const twips = pxToTwips({ x: e.clientX - rect.left, y: e.clientY - rect.top }, scale());
    void postInput({ kind: "mouse", type: "UP", x: twips.x, y: twips.y, count: e.detail, buttons: 1, modifier: 0 })
      .then(scheduleRerender);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Proven directly (Stage 0/1), unlike the AWT_KEYCODE table — routed
      // through the symbolic uno command rather than a raw key.
      void import("../../lok/client.js").then(({ unoCommand }) => unoCommand("escape")).then(scheduleRerender);
      return;
    }
    if (e.key.length === 1) {
      // Printable character: Unicode code point as charCode, keyCode 0 —
      // the exact shape proven working in Stage 0/1 ("Do" typed into a
      // title placeholder).
      e.preventDefault();
      void postInput({ kind: "key", type: "INPUT", charCode: e.key.codePointAt(0) ?? 0, keyCode: 0 });
      return;
    }
    const keyCode = AWT_KEYCODE[e.key];
    if (keyCode !== undefined) {
      e.preventDefault();
      void postInput({ kind: "key", type: "INPUT", charCode: 0, keyCode });
    }
  }

  function handleKeyUp(e: React.KeyboardEvent) {
    if (e.key === "Escape") return; // handled entirely on keydown above
    if (e.key.length === 1) {
      void postInput({ kind: "key", type: "UP", charCode: e.key.codePointAt(0) ?? 0, keyCode: 0 })
        .then(scheduleRerender);
      return;
    }
    const keyCode = AWT_KEYCODE[e.key];
    if (keyCode !== undefined) {
      void postInput({ kind: "key", type: "UP", charCode: 0, keyCode }).then(scheduleRerender);
    }
  }

  const selectionPx = selection ? twipsRectToPx(selection, scale()) : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className="relative aspect-video w-full select-none bg-white outline-none focus:ring-2 focus:ring-emerald-500"
    >
      <img
        src={slideUrl(slideIndex, revision)}
        alt={`Slide ${slideIndex + 1}`}
        draggable={false}
        className="pointer-events-none block h-full w-full"
      />
      {selectionPx && (
        <div
          className="pointer-events-none absolute border-2 border-blue-500"
          style={{ left: selectionPx.x, top: selectionPx.y, width: selectionPx.w, height: selectionPx.h }}
        />
      )}
    </div>
  );
}
