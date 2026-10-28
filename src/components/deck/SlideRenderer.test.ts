import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Slide, Theme } from "../../schema/deck.js";
import { SlideRenderer } from "./SlideRenderer.js";

// The app chrome's semantic colours. None may appear in a rendered slide: its colours are the deck's own data.
const TOKENS = /var\(--color-|var\(--studio-|\b(bg|text|border|ring)-(canvas|panel|raised|line|fg|muted|faint|accent|warning|success|danger|stage)\b/;

const text = { kind: "text", id: crypto.randomUUID(), x: 0, y: 0, w: 400, h: 100, text: "Verse 1", role: "title" };
const render = (slide: Slide, theme: Theme, scale: number) =>
  renderToStaticMarkup(createElement(SlideRenderer, { slide, theme, scale }));

describe("SlideRenderer colours come from the deck, never from the app's tokens", () => {
  const theme = Theme.parse({ background: { kind: "color", color: "#fafafa" }, text: "#222222" });

  it.each([0.15, 0.6, 1])("paints a slide's own background colour at scale %s", (scale) => {
    const slide = Slide.parse({ id: crypto.randomUUID(), background: { kind: "color", color: "#ff0000" }, elements: [text] });
    const html = render(slide, theme, scale);
    expect(html).toContain("background-color:#ff0000");
    expect(html).not.toMatch(TOKENS);
  });

  it.each([0.15, 0.6, 1])("falls back to the deck theme's background and text colour at scale %s", (scale) => {
    const html = render(Slide.parse({ id: crypto.randomUUID(), elements: [text] }), theme, scale);
    expect(html).toContain("background-color:#fafafa");
    expect(html).toContain("color:#222222");
    expect(html).not.toMatch(TOKENS);
  });
});
