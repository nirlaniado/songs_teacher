// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SLIDE_H, SLIDE_W, Slide, Theme, summarizeDeck } from "../../schema/deck.js";
import { useDeckStore } from "../../store/deckStore.js";
import { appearanceDifferences, computed, installAppCss, openDeck, slideLayers, slideScale, slideStyles, stubResizeObserver } from "../../test/dom.js";
import { DeckLibraryScreen } from "../DeckLibraryScreen.js";
import { PresentMode } from "./PresentMode.js";
import { SlideCanvas } from "./SlideCanvas.js";
import { SlidePanel } from "./SlidePanel.js";
import { SlideRenderer } from "./SlideRenderer.js";

// Hard rule 0: one renderer, mounted at several scales, must draw the same slide everywhere. These mount the real
// parents under the app's compiled stylesheet and compare every computed style jsdom resolves (selector matches and
// inheritance) for SlideRenderer's surface, its scaled layer and each node of the slide's content, every one with its
// `::before` and `::after`, against the same slide rendered on its own at the same scale. jsdom does no layout and no painting: what a box ends up measuring,
// what overlaps what and in which order things paint are out of reach here.
//
// The canvas and Present size the slide to their own box, read with getBoundingClientRect, which jsdom always
// reports as 0×0. It is STUBBED below to a fixed box so those two have a real scale to assert.
const BOX = { width: 688, height: 408 };
const EXPECTED_SCALE = {
  rail: 0.115, // SlidePanel's THUMB_SCALE
  libraryRow: 0.1, // DeckLibraryScreen's ROW_THUMB_SCALE
  libraryCard: 0.125, // DeckLibraryScreen's CARD_THUMB_SCALE
  canvas: Math.min((BOX.width - 48) / SLIDE_W, (BOX.height - 48) / SLIDE_H), // "fit": the box, less a 48px margin
  present: Math.min(BOX.width / SLIDE_W, BOX.height / SLIDE_H), // fills the box, aspect kept
};
const rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;

const theme = Theme.parse({ background: { kind: "color", color: "#fafafa" }, text: "#222222" });
const slide = Slide.parse({
  id: "00000000-0000-4000-8000-000000000001",
  elements: [
    { kind: "text", id: "00000000-0000-4000-8000-000000000002", x: 80, y: 60, w: 1120, h: 140, text: "Verse 1", role: "title" },
    { kind: "tab", id: "00000000-0000-4000-8000-000000000003", x: 80, y: 240, w: 560, h: 200, text: "e|---0---|\nB|---1---|" },
    { kind: "shape", id: "00000000-0000-4000-8000-000000000004", x: 700, y: 240, w: 320, h: 200, shape: "roundRect", strokeWidth: 2 },
    { kind: "image", id: "00000000-0000-4000-8000-000000000005", x: 700, y: 460, w: 320, h: 200, src: "assets/a.png", fit: "contain" },
  ],
});
const assetUrls = { "assets/a.png": "blob:test/assets/a.png" };
/**
 * How many of the layer's children are the slide's own content, counted from the slide drawn on its own:
 * the background, each element view, and the hidden measuring copy each text and tab view keeps beside
 * it. The canvas adds editor chrome after these, which is not slide content.
 */
let CONTENT = 0;

beforeAll(async () => {
  stubResizeObserver();
  await installAppCss();
  Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: BOX.width, bottom: BOX.height, ...BOX, toJSON() {} }) as DOMRect;
  const { container } = render(<SlideRenderer slide={slide} theme={theme} scale={1} assetUrls={assetUrls} />);
  CONTENT = slideLayers(container)[0]!.children.length;
  cleanup();
  expect(CONTENT).toBeGreaterThan(slide.elements.length);
});
afterAll(() => Object.defineProperty(Element.prototype, "getBoundingClientRect", rect));
afterEach(cleanup);

/** The one mounted slide in `container`, once its image has resolved. */
async function layerIn(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('img[src="blob:test/assets/a.png"]')).not.toBeNull());
  const layers = slideLayers(container);
  expect(layers).toHaveLength(1);
  return layers[0]!;
}

/** The slide drawn on its own at `scale`, with the class the mount gave its surface, so only the mount's surroundings differ. */
async function alone(scale: number, className?: string) {
  const { container } = render(<SlideRenderer slide={slide} theme={theme} scale={scale} assetUrls={assetUrls} className={className} />);
  const styles = slideStyles(await layerIn(container), CONTENT);
  cleanup();
  return styles;
}

/** The surface is 1280·scale × 720·scale and the layer is scaled by exactly `scale` (compared as numbers: CSS rounds). */
function expectScale({ width, height, transform }: ReturnType<typeof slideScale>, scale: number) {
  const factor = /^scale\(([^)]*)\)$/.exec(transform)?.[1];
  expect({ width: parseFloat(width), height: parseFloat(height), scale: Number(factor) }).toEqual({
    width: expect.closeTo(SLIDE_W * scale, 6), height: expect.closeTo(SLIDE_H * scale, 6), scale: expect.closeTo(scale, 9),
  });
}

function openLibrary(view: "list" | "grid") {
  const deck = openDeck([slide], theme);
  act(() => useDeckStore.setState({ decks: [summarizeDeck(deck)], loadingDecks: false, libraryView: view, error: null }));
}

const MOUNTS = [
  ["the thumbnail rail", EXPECTED_SCALE.rail, () => { openDeck([slide], theme); return <SlidePanel />; }],
  ["the editor canvas", EXPECTED_SCALE.canvas, () => { openDeck([slide], theme); return <SlideCanvas />; }],
  ["Present", EXPECTED_SCALE.present, () => { openDeck([slide], theme); return <PresentMode onExit={() => {}} />; }],
  ["a library row", EXPECTED_SCALE.libraryRow, () => { openLibrary("list"); return <DeckLibraryScreen onOpen={() => {}} />; }],
  ["a library card", EXPECTED_SCALE.libraryCard, () => { openLibrary("grid"); return <DeckLibraryScreen onOpen={() => {}} />; }],
] as const;

/** Mounts `place` and returns its slide layer next to the slide drawn on its own at the same scale and surface class. */
async function mounted(mount: () => React.ReactElement) {
  const { container } = render(mount());
  const layer = await layerIn(container);
  const got = slideStyles(layer, CONTENT);
  const { className } = layer.parentElement!;
  const scale = Number(/^scale\((.*)\)$/.exec(layer.style.transform)![1]);
  const measured = slideScale(layer);
  cleanup();
  return { got, reference: await alone(scale, className || undefined), measured };
}

describe("a slide looks the same in every place it is mounted", () => {
  it("draws the same content at every scale it is mounted at, sized to that scale", async () => {
    const scaleFree = (nodes: Awaited<ReturnType<typeof alone>>) => nodes.map(({ path, style }) => {
      const { width: _w, height: _h, "inline-size": _i, "block-size": _b, transform: _t, "transform-origin": _o, ...rest } = style;
      return { path, style: path === "surface" || path === "layer" ? rest : style };
    });
    const reference = scaleFree(await alone(1));
    for (const scale of Object.values(EXPECTED_SCALE)) {
      const { container } = render(<SlideRenderer slide={slide} theme={theme} scale={scale} assetUrls={assetUrls} />);
      const layer = await layerIn(container);
      expectScale(slideScale(layer), scale);
      expect(scaleFree(slideStyles(layer, CONTENT))).toEqual(reference);
      cleanup();
    }
  });

  it.each(MOUNTS)("in %s, at its own scale, matches the slide drawn on its own", async (_place, scale, mount) => {
    const { got, reference, measured } = await mounted(mount);
    expectScale(measured, scale);
    expect(appearanceDifferences(reference, got)).toEqual([]);
  });

  it.each([
    [".slide-thumb img { opacity: .5 }", [/^layer>.*>img\[0\] opacity: 1 -> 0\.5$/]],
    [".slide-thumb .ring-line { opacity: .5 }", [/^surface opacity: 1 -> 0\.5$/]],
    // A custom property set on the surface and read only by a pseudo-element: the overlay it draws shows
    // up nowhere but in that pseudo-element's own computed style (#47).
    [
      `.slide-thumb .ring-line { --leak-opacity: .5 }
       .ring-line::after { content: ""; position: absolute; inset: 0; background: black; opacity: var(--leak-opacity, 0) }`,
      // The custom property is inherited, so every node below the surface reports it too; the overlay itself
      // is the surface's ::after opacity, which must be among the differences.
      [/^surface::after opacity: 0 -> 0\.5$/, /^(surface|layer)\S* --leak-opacity: undefined -> \.5$/],
    ],
    [".slide-thumb .ring-line > div > div::before { content: \"!\" }", [/^layer>div\[\d+\]::before content: none -> "!"$/]],
  ] as const)("would notice %s reaching into a mounted slide", async (rule, expected) => {
    const leak = document.createElement("style");
    leak.textContent = rule;
    document.head.append(leak);
    try {
      const { got, reference } = await mounted(MOUNTS[0][2]);
      const differences = appearanceDifferences(reference, got);
      expect(differences.filter((d) => !expected.some((re) => re.test(d)))).toEqual([]);
      for (const re of expected) expect(differences.some((d) => re.test(d)), String(re)).toBe(true);
    } finally {
      leak.remove();
    }
  });
});

describe("the thumbnail rail keeps control styling away from the slide it wraps", () => {
  async function thumb() {
    openDeck([slide, { ...slide, id: "00000000-0000-4000-8000-0000000000aa" }], theme);
    const { container } = render(<SlidePanel />);
    await waitFor(() => expect(slideLayers(container)).toHaveLength(2));
    return slideLayers(container).map((layer) => layer.closest("button")!);
  }

  it("wraps each slide in a plain slide-thumb button, not a control", async () => {
    for (const button of await thumb()) {
      expect(button.classList.contains("slide-thumb")).toBe(true);
      expect([...button.classList].filter((c) => /^(control|field|menu-item|tile|row)/.test(c))).toEqual([]);
    }
  });

  it("gives the thumb no transform, motion or type styles of its own, selected or not", async () => {
    const buttons = await thumb();
    expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual(["true", null]);
    // What a button with no classes gets, so only what slide-thumb itself adds can differ.
    const plain = computed(buttons[0]!.parentElement!.appendChild(document.createElement("button")));
    for (const button of buttons) {
      const own = computed(button);
      const parent = computed(button.parentElement!);
      const motion = Object.keys(own).filter((p) => /^(transform|transition|animation|scale|translate|rotate)/.test(p));
      expect(motion.length).toBeGreaterThan(0);
      expect(motion.filter((p) => own[p] !== plain[p]).map((p) => `${p}: ${own[p]}`)).toEqual([]);
      for (const p of ["font-family", "font-size", "font-weight", "letter-spacing", "line-height", "color"]) expect([p, own[p]]).toEqual([p, parent[p]]);
      expect(own.position).toBe("relative");
    }
  });

  // What jsdom can show is the stacking set-up; that the ring then paints under the slide is painting.
  it("draws the selection ring in a stacking context of its own, below the slide", async () => {
    const [selected] = await thumb();
    expect(computed(selected!).isolation).toBe("isolate");
    const ring = computed(selected!, "::after");
    expect(ring["z-index"]).toBe("-1");
    expect(ring.position).toBe("absolute");
  });
});
