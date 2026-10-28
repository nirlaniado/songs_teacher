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
