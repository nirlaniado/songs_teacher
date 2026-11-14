// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Slide, Theme } from "../../schema/deck.js";
import { appearanceDifferences, computed, installAppCss, openDeck, slideContentStyles, slideLayers, stubResizeObserver } from "../../test/dom.js";
import { DeckThumbnail } from "../DeckLibraryScreen.js";
import { PresentMode } from "./PresentMode.js";
import { SlideCanvas } from "./SlideCanvas.js";
import { SlidePanel } from "./SlidePanel.js";
import { SlideRenderer } from "./SlideRenderer.js";

// Hard rule 0: one renderer, mounted at several scales, must draw the same slide everywhere. These mount the
// real parents under the app's real stylesheet and compare every computed style jsdom resolves for the slide's
// content — selector matches, inheritance, `::after` — against the same slide rendered on its own. jsdom does no
// layout or painting, so overlap and paint order are out of reach here; everything a CSS rule can set is not.

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
  const { container } = render(<SlideRenderer slide={slide} theme={theme} scale={1} assetUrls={assetUrls} />);
  CONTENT = slideLayers(container)[0]!.children.length;
  cleanup();
  expect(CONTENT).toBeGreaterThan(slide.elements.length);
});
afterEach(cleanup);

/** The slide's content styles inside `container`, once its image has resolved. */
async function contentIn(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('img[src="blob:test/assets/a.png"]')).not.toBeNull());
  const layers = slideLayers(container);
  expect(layers).toHaveLength(1);
  return slideContentStyles(layers[0]!, CONTENT);
}

async function alone(scale: number) {
  const { container } = render(<SlideRenderer slide={slide} theme={theme} scale={scale} assetUrls={assetUrls} />);
  const styles = await contentIn(container);
  cleanup();
  return styles;
}

describe("a slide looks the same in every place it is mounted", () => {
  it("is the same on its own at every scale it is mounted at", async () => {
    const reference = await alone(1);
    expect(slideLayers(document).length).toBe(0);
    for (const scale of [0.1, 0.115, 0.125, 0.6, 1.125]) expect(await alone(scale)).toEqual(reference);
  });

  it.each([
    ["the thumbnail rail", () => <SlidePanel />],
    ["the editor canvas", () => <SlideCanvas />],
    ["Present", () => <PresentMode onExit={() => {}} />],
    ["a library card", () => <DeckThumbnail cover={{ slide, theme }} scale={0.125} assetUrls={assetUrls} />],
  ])("in %s, matches the slide drawn on its own", async (_place, mount) => {
    const reference = await alone(1);
    openDeck([slide], theme);
    const { container } = render(mount());
    expect(appearanceDifferences(reference, await contentIn(container))).toEqual([]);
  });

  it("would notice a stylesheet rule reaching into a mounted slide", async () => {
    openDeck([slide], theme);
    const leak = document.createElement("style");
    leak.textContent = ".slide-thumb img { opacity: .5 }";
    document.head.append(leak);
    try {
      const reference = await alone(1);
      const { container } = render(<SlidePanel />);
      const differences = appearanceDifferences(reference, await contentIn(container));
      expect(differences).toHaveLength(1);
      expect(differences[0]).toMatch(/>img\[0\] opacity: 1 -> 0\.5$/);
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
