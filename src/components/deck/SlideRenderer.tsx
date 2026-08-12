import { useLayoutEffect, useRef, useState } from "react";
import {
  SLIDE_H,
  SLIDE_W,
  type Background,
  type Slide,
  type SlideElement,
  type Theme,
} from "../../schema/deck.js";

/**
 * Renders one slide at a fixed 1280x720 and lets the caller scale it.
 *
 * The editor canvas, the slide-panel thumbnails, and fullscreen presentation
 * all mount *this* component and differ only in the `scale` they pass, so a
 * slide is guaranteed to look the same in all three. Anything that varies by
 * context (selection outlines, drag handles) is layered on top by the caller
 * rather than branched on in here.
 */

/**
 * Paints a slide's backdrop: a flat color, or a saved image with a fit mode
 * and an optional black dimmer beneath the elements. Photographic backdrops
 * routinely swallow text, and the dimmer is what makes them usable without
 * editing the image outside the app.
 *
 * A referenced image that hasn't resolved yet (or is missing) falls back to
 * the theme's own color rather than flashing white.
 */
function BackgroundLayer({
  background,
  theme,
  assetUrls,
}: {
  background: Background;
  theme: Theme;
  assetUrls: Record<string, string>;
}) {
  if (background.kind === "color") {
    return <div style={{ position: "absolute", inset: 0, backgroundColor: background.color }} />;
  }

  const url = assetUrls[background.src];
  const fallback = theme.background.kind === "color" ? theme.background.color : "#000000";
  if (!url) return <div style={{ position: "absolute", inset: 0, backgroundColor: fallback }} />;

  const tiled = background.fit === "tile";
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: fallback,
          backgroundImage: `url("${url}")`,
          backgroundRepeat: tiled ? "repeat" : "no-repeat",
          backgroundPosition: "center",
          backgroundSize: tiled
            ? "auto"
            : background.fit === "fill"
              ? "100% 100%"
              : background.fit,
        }}
      />
      {background.dim > 0 && (
        <div
          style={{ position: "absolute", inset: 0, backgroundColor: "#000", opacity: background.dim }}
        />
      )}
    </>
  );
}

export function elementStyle(el: SlideElement): React.CSSProperties {
  return {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
  };
}

/**
 * `valign` as flexbox. Exported so the editor's inline text field can align
 * its content the same way — a textarea has no vertical alignment of its own,
 * and text that jumps when you stop typing is its own kind of bug.
 */
export const JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

/** Shared by the tab element's rendered view and its inline editor. */
export const TAB_FONT_STACK = '"Menlo","Consolas","SFMono-Regular",ui-monospace,monospace';

/**
 * The largest font size, at or below `maxFontSize`, that fits `text` inside
 * a `boxW`×`boxH` box — PowerPoint's "shrink text on overflow". Resizing a
 * box down used to just clip whatever no longer fit; this makes it shrink
 * instead, which is what people expect when they drag a handle inward.
 *
 * Recomputed fresh from the current box size on every render, never stored —
 * so it's always correct for whatever the box currently is, and undoing a
 * resize doesn't need to remember or restore a font size, because nothing
 * about the *content* ever actually changed.
 *
 * Measured with a hidden clone of the real typography rather than estimated
 * from character counts: a proportional font's per-character width varies
 * too much for a cheap approximation to reliably match real wrapping.
 */
function useShrinkToFit({
  text,
  maxFontSize,
  boxW,
  boxH,
  typography,
}: {
  text: string;
  maxFontSize: number;
  boxW: number;
  boxH: number;
  /** Must match the visible render exactly — anything that affects wrapping
   * or glyph width has to be identical on the probe, or the measurement lies. */
  typography: Pick<
    React.CSSProperties,
    "fontFamily" | "fontWeight" | "fontStyle" | "lineHeight" | "whiteSpace" | "wordBreak"
  >;
}) {
  const probeRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const node = probeRef.current;
    if (!node || boxW <= 0 || boxH <= 0) {
      setFontSize(maxFontSize);
      return;
    }
    const measureAt = (size: number) => {
      node.style.fontSize = `${size}px`;
      return { h: node.scrollHeight, w: node.scrollWidth };
    };

    const atMax = measureAt(maxFontSize);
    if (atMax.h <= boxH && atMax.w <= boxW) {
      setFontSize(maxFontSize);
      return;
    }

    // Scale down proportionally to how much it overflowed, then refine once —
    // shrinking the font also changes how wrapped text re-flows, so the
    // first pass lands close but is rarely exact.
    let size = Math.max(1, maxFontSize * Math.min(boxH / (atMax.h || 1), boxW / (atMax.w || 1)));
    const refined = measureAt(size);
    if (refined.h > boxH || refined.w > boxW) {
      size = Math.max(1, size * Math.min(boxH / (refined.h || 1), boxW / (refined.w || 1)));
    }
    setFontSize(size);
  }, [
    text,
    maxFontSize,
    boxW,
    boxH,
    typography.fontFamily,
    typography.fontWeight,
    typography.fontStyle,
    typography.lineHeight,
    typography.whiteSpace,
    typography.wordBreak,
  ]);

  return { fontSize, probeRef };
}

/**
 * Renders `text` at its shrink-to-fit size inside `frameStyle`'s box, plus
 * the off-screen probe `useShrinkToFit` measures against.
 *
 * A dedicated component rather than inlined into `ElementView`: hooks must
 * run unconditionally, and `ElementView` branches by element kind with early
 * returns, so a hook call inside only some of those branches would violate
 * the rules of hooks (different kinds would call a different number of
 * hooks). Nesting it one level down sidesteps that — `FitText` always calls
 * its hook exactly once, whichever kind chose to render it.
 */
function FitText({
  text,
  maxFontSize,
  boxW,
  boxH,
  frameStyle,
}: {
  text: string;
  maxFontSize: number;
  boxW: number;
  boxH: number;
  /** Everything `ElementView` would have put on the div directly, minus
   * `fontSize` — this component owns that one value. */
  frameStyle: React.CSSProperties;
}) {
  const { fontSize, probeRef } = useShrinkToFit({ text, maxFontSize, boxW, boxH, typography: frameStyle });
  return (
    <>
      <div style={{ ...frameStyle, fontSize }}>{text}</div>
      {/* Off-screen at the full requested size — never painted, never in the
          tab order, exists purely so `scrollHeight`/`scrollWidth` can answer
          "would this actually fit". */}
      <div
        ref={probeRef}
        aria-hidden
        style={{
          position: "fixed",
          top: -99999,
          left: -99999,
          width: boxW,
          visibility: "hidden",
          pointerEvents: "none",
          fontFamily: frameStyle.fontFamily,
          fontWeight: frameStyle.fontWeight,
          fontStyle: frameStyle.fontStyle,
          lineHeight: frameStyle.lineHeight,
          whiteSpace: frameStyle.whiteSpace,
          wordBreak: frameStyle.wordBreak,
        }}
      >
        {text}
      </div>
    </>
  );
}

export function ElementView({
  element,
  theme,
  assetUrls,
}: {
  element: SlideElement;
  theme: Theme;
  assetUrls: Record<string, string>;
}) {
  if (element.kind === "text") {
    const s = element.style;
    return (
      <FitText
        text={element.text}
        maxFontSize={s.fontSize}
        boxW={element.w}
        boxH={element.h}
        frameStyle={{
          ...elementStyle(element),
          display: "flex",
          flexDirection: "column",
          justifyContent: JUSTIFY[s.valign],
          textAlign: s.align,
          fontWeight: s.bold ? 700 : 400,
          fontStyle: s.italic ? "italic" : "normal",
          textDecoration: s.underline ? "underline" : "none",
          color: s.color ?? theme.text,
          fontFamily: s.fontFamily ?? theme.fontFamily,
          lineHeight: s.lineHeight,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "hidden",
        }}
      />
    );
  }

  if (element.kind === "tab") {
    const s = element.style;
    return (
      <FitText
        text={element.text}
        maxFontSize={s.fontSize}
        boxW={element.w}
        boxH={element.h}
        frameStyle={{
          ...elementStyle(element),
          display: "flex",
          flexDirection: "column",
          justifyContent: JUSTIFY[s.valign],
          color: s.color ?? theme.text,
          lineHeight: s.lineHeight,
          // Monospace is forced, not themed: tab notation is an ASCII grid
          // where every character must occupy the same width, or the string
          // lines drift out of vertical alignment with each other.
          fontFamily: TAB_FONT_STACK,
          // `pre`, not `pre-wrap`: a wrapped line would restart at the box's
          // left edge and misalign against string lines below it that didn't
          // wrap at the same column. A too-long line still overflows the
          // box — shrinking gets it most of the way there, but there's a
          // floor (1px) it won't go below.
          whiteSpace: "pre",
          overflow: "hidden",
        }}
      />
    );
  }

  if (element.kind === "image") {
    const url = assetUrls[element.src];
    return (
      <div style={{ ...elementStyle(element), overflow: "hidden" }}>
        {url ? (
          <img
            src={url}
            alt={element.caption ?? ""}
            style={{ width: "100%", height: "100%", objectFit: element.fit, display: "block" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              border: `2px dashed ${theme.text}40`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: `${theme.text}80`,
              fontSize: 20,
              fontFamily: theme.fontFamily,
            }}
          >
            image
          </div>
        )}
      </div>
    );
  }

  // shape
  const common: React.CSSProperties = {
    ...elementStyle(element),
    backgroundColor: element.shape === "line" || element.shape === "arrow" ? undefined : element.fill ?? theme.accent,
    border: element.strokeWidth > 0 ? `${element.strokeWidth}px solid ${element.stroke ?? theme.text}` : undefined,
  };
  if (element.shape === "ellipse") return <div style={{ ...common, borderRadius: "50%" }} />;
  if (element.shape === "roundRect") return <div style={{ ...common, borderRadius: 16 }} />;
  if (element.shape === "line" || element.shape === "arrow") {
    return (
      <div style={{ ...elementStyle(element), display: "flex", alignItems: "center" }}>
        <div
          style={{
            width: "100%",
            height: Math.max(2, element.strokeWidth || 4),
            backgroundColor: element.stroke ?? element.fill ?? theme.accent,
          }}
        />
        {element.shape === "arrow" && (
          <div
            style={{
              width: 0,
              height: 0,
              borderTop: `${Math.max(6, (element.strokeWidth || 4) * 2.5)}px solid transparent`,
              borderBottom: `${Math.max(6, (element.strokeWidth || 4) * 2.5)}px solid transparent`,
              borderLeft: `${Math.max(10, (element.strokeWidth || 4) * 4)}px solid ${
                element.stroke ?? element.fill ?? theme.accent
              }`,
              flexShrink: 0,
            }}
          />
        )}
      </div>
    );
  }
  return <div style={common} />;
}

/**
 * The slide surface. `scale` maps the 1280x720 logical space onto whatever
 * box the caller has; the outer div reserves the scaled size so the slide
 * occupies real layout space instead of overflowing its parent.
 */
export function SlideRenderer({
  slide,
  theme,
  scale,
  assetUrls = {},
  children,
  className,
  surfaceRef,
  hiddenElementIds,
}: {
  slide: Slide | null;
  theme: Theme;
  scale: number;
  assetUrls?: Record<string, string>;
  /** Editor chrome (selection outlines, handles) drawn in slide coordinates. */
  children?: React.ReactNode;
  className?: string;
  /**
   * The slide's screen-space box, for converting pointer positions into slide
   * units. Only the editor needs it; a plain ref rather than a second renderer.
   */
  surfaceRef?: React.Ref<HTMLDivElement>;
  /**
   * Elements the caller is drawing itself, so this one must not.
   *
   * The editor lays a live text field over the element being edited; without
   * this the element's own text renders underneath it and the user sees every
   * character twice, offset by the field's border.
   */
  hiddenElementIds?: readonly string[];
}) {
  const hidden = hiddenElementIds?.length ? new Set(hiddenElementIds) : null;
  return (
    <div
      ref={surfaceRef}
      className={className}
      style={{
        width: SLIDE_W * scale,
        height: SLIDE_H * scale,
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: SLIDE_W,
          height: SLIDE_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        <BackgroundLayer
          background={slide?.background ?? theme.background}
          theme={theme}
          assetUrls={assetUrls}
        />
        {slide?.elements.map((el) =>
          hidden?.has(el.id) ? null : (
            <ElementView key={el.id} element={el} theme={theme} assetUrls={assetUrls} />
          ),
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Every image path the given slides need resolved, for `useDeckAssets` —
 * image elements *and* background images, including the theme's, since a
 * slide that inherits the master backdrop still has to paint it.
 */
export function imagePathsOf(slides: readonly Slide[], theme?: Theme): string[] {
  const out = new Set<string>();
  if (theme?.background.kind === "image") out.add(theme.background.src);
  for (const slide of slides) {
    if (slide.background?.kind === "image") out.add(slide.background.src);
    for (const el of slide.elements) if (el.kind === "image") out.add(el.src);
  }
  return [...out];
}
