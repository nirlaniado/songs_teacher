import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Slide, Theme } from "../../schema/deck.js";
import { SlideRenderer } from "./SlideRenderer.js";

// Every colour token index.css defines, read from the file so a new one is covered without editing this list. None may
// appear in a rendered slide, as a variable or a utility: a slide's colours are the deck's own data.
const NAMES = [...readFileSync(new URL("../../index.css", import.meta.url), "utf8").matchAll(/--color-([a-z-]+):/g)].map((m) => m[1]!);
const UTILITY = new RegExp(`^[a-z:-]*-(${NAMES.join("|")})(/\\d+)?$`);
/** Token variables anywhere, or token utilities in a class list (inline CSS like `pre-line` is not a utility). */
const leaks = (html: string) =>
  /var\(--(color|studio)-/.test(html) ||
  [...html.matchAll(/class="([^"]*)"/g)].some((m) => m[1]!.split(/\s+/).some((c) => UTILITY.test(c)));

const text = { kind: "text", id: crypto.randomUUID(), x: 0, y: 0, w: 400, h: 100, text: "Verse 1", role: "title" };
const render = (slide: Slide, theme: Theme, scale: number) =>
  renderToStaticMarkup(createElement(SlideRenderer, { slide, theme, scale }));

describe("SlideRenderer colours come from the deck, never from the app's tokens", () => {
  it("guards every token index.css defines, including the editor-only ones", () => {
    expect(NAMES).toEqual(expect.arrayContaining(["canvas", "accent", "danger-soft", "grid", "guide", "stage"]));
    for (const name of NAMES) expect(leaks(`<div class="p-1 hover:bg-${name}">`)).toBe(true);
    expect(leaks('<div style="white-space:pre-line">')).toBe(false);
  });

  const theme = Theme.parse({ background: { kind: "color", color: "#fafafa" }, text: "#222222" });

  it.each([0.15, 0.6, 1])("paints a slide's own background colour at scale %s", (scale) => {
    const slide = Slide.parse({ id: crypto.randomUUID(), background: { kind: "color", color: "#ff0000" }, elements: [text] });
    const html = render(slide, theme, scale);
    expect(html).toContain("background-color:#ff0000");
    expect(leaks(html)).toBe(false);
  });

  it.each([0.15, 0.6, 1])("falls back to the deck theme's background and text colour at scale %s", (scale) => {
    const html = render(Slide.parse({ id: crypto.randomUUID(), elements: [text] }), theme, scale);
    expect(html).toContain("background-color:#fafafa");
    expect(html).toContain("color:#222222");
    expect(leaks(html)).toBe(false);
  });
});

// Whether the slide draws the same wherever it is mounted is SlideRenderer.mounts.test.tsx; this pins only
// that the renderer's own output carries none of the control layer's classes or motion.
describe("SlideRenderer carries no control styling", () => {
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

  it.each([0.1, 0.115, 0.125, 0.6, 1.125])("carries no control class, radius or motion at scale %s", (scale) => {
    const classes = [...render(slide, theme, scale).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    expect(classes.filter((c) => /^(control|field|menu-item|tile|row|pop|fade|panel-rise|rounded|transition|animate)/.test(c))).toEqual([]);
    expect(render(slide, theme, scale)).not.toMatch(/transition|animation|var\(--(motion|radius|press|enter)/);
  });
});
