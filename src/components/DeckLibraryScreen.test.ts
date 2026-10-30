import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Slide, Theme, type DeckSummary } from "../schema/deck.js";
import { NAV_ITEMS } from "./AppNav.js";
import { DeckItem, DeckLibraryScreen, DeckResultsEmpty, Waveform, type DeckCover } from "./DeckLibraryScreen.js";

const summary = (over: Partial<DeckSummary> = {}): DeckSummary => ({
  id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
  title: "Someone Like You",
  slideCount: 11,
  hasAudio: true,
  updatedAt: "2026-10-28T12:00:00.000Z",
  ...over,
});
const slide = Slide.parse({ id: crypto.randomUUID(), elements: [{ kind: "text", id: crypto.randomUUID(), x: 0, y: 0, w: 400, h: 100, text: "Verse 1", role: "title" }] });
const covered: DeckCover = { slide, theme: Theme.parse({}) };
const noSlides: DeckCover = { slide: null, theme: Theme.parse({}) };

const item = (view: "list" | "grid", cover: DeckCover, deck = summary()) =>
  renderToStaticMarkup(createElement(DeckItem, { deck, view, cover, onOpen: vi.fn(), onDelete: vi.fn() }));

describe.each(["list", "grid"] as const)("a %s item", (view) => {
  it("draws the deck's own first slide with the shared renderer", () => {
    const html = item(view, covered);
    expect(html).toContain("Verse 1");
    expect(html).not.toContain("deck-thumb-empty");
  });

  it("draws a 16:9 placeholder for a deck with no slides, and no slide content", () => {
    const html = item(view, noSlides, summary({ slideCount: 0 }));
    expect(html).toContain("deck-thumb-empty");
    expect(html).not.toContain("Verse 1");
    const [, w, h] = /width:([\d.]+)px;height:([\d.]+)px/.exec(html)!;
    expect(Number(w) / Number(h)).toBeCloseTo(16 / 9);
  });

  it("reserves the same box while the cover loads, so the row does not jump", () => {
    expect(item(view, undefined)).toContain("deck-thumb-empty");
  });

  // Nesting a renderer inside a Button would press-scale the slide; see the slide rail's .slide-thumb for the same call.
  it("holds the renderer outside every Button and the open target", () => {
    const html = item(view, covered);
    expect(html.indexOf("Verse 1")).toBeGreaterThan(-1);
    expect(html.indexOf("Verse 1")).toBeLessThan(html.indexOf("<button"));
  });

  it("keeps the thumbnail out of the accessibility tree, because the title already names the deck", () => {
    expect(item(view, covered)).toMatch(/class="deck-thumb" aria-hidden="true"/);
  });

  it("reaches keyboard users through one real button named for the deck", () => {
    expect(item(view, covered)).toMatch(/<button class="deck-open"[^>]*>Someone Like You<\/button>/);
  });

  it("offers Delete behind a named menu, closed until asked", () => {
    const html = item(view, covered);
    expect(html).toContain('aria-label="More actions for Someone Like You"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("menuitem");
  });

  it("only claims audio when the deck has some", () => {
    expect(item(view, covered)).toContain("has audio");
    expect(item(view, covered, summary({ hasAudio: false }))).not.toContain("has audio");
  });

  it("gives a silent deck a flat line, not a sound it lacks", () => {
    expect(item(view, covered, summary({ hasAudio: false }))).toContain("waveform-silent");
    expect(item(view, covered)).not.toContain("waveform-silent");
  });

  it("keeps a very long title whole for the tooltip and to assistive tech", () => {
    const title = "A very long title ".repeat(12).trim();
    expect(item(view, covered, summary({ title }))).toContain(`title="${title}"`);
  });

  it("gets a singular right", () => {
    expect(item(view, covered, summary({ slideCount: 1 }))).toMatch(/1 slide<\/span>/);
  });
});

describe("the two view modes", () => {
  it("are the mockups' layouts: only the list has the Open button and the date", () => {
    expect(item("list", covered)).toContain("deck-row");
    expect(item("list", covered)).toContain('aria-label="Open Someone Like You"');
    expect(item("list", covered)).toContain("Last updated");
    expect(item("grid", covered)).toContain("deck-card");
    expect(item("grid", covered)).not.toContain('aria-label="Open Someone Like You"');
  });

  it("uses the honest word: nothing tracks opening, so the date is last updated", () => {
    expect(item("list", covered)).not.toMatch(/last opened/i);
  });

  it("renders the slide at a thumbnail scale and no other change", () => {
    expect(item("list", covered)).toContain("width:128px;height:72px");
    expect(item("grid", covered)).toContain("width:160px;height:90px");
  });
});

describe("the waveform", () => {
  const wave = (seed: string) => renderToStaticMarkup(createElement(Waveform, { seed, bars: 40, silent: false }));

  it("draws differently per deck and the same on every render", () => {
    expect(wave("deck-a").replace(/wave[\w-]*/g, "")).toBe(wave("deck-a").replace(/wave[\w-]*/g, ""));
    expect(wave("deck-a").replace(/wave[\w-]*/g, "")).not.toBe(wave("deck-b").replace(/wave[\w-]*/g, ""));
  });

  it("carries nothing that could be read as a measurement", () => {
    const html = wave("deck-a");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/<text|<title|\d:\d\d/);
    for (const view of ["list", "grid"] as const) expect(item(view, covered, summary({ updatedAt: "2026-10-28T12:00:00.000Z" }))).not.toMatch(/\b\d:\d\d\b/);
  });
});

describe("empty states", () => {
  it("reads an unsuccessful search as a result, with the way back", () => {
    const html = renderToStaticMarkup(createElement(DeckResultsEmpty, { query: " zzz ", onClear: vi.fn() }));
    expect(html).toContain("No presentations match “zzz”");
    expect(html).toContain("Clear search");
    expect(html).not.toContain("No presentations yet");
  });

  it("reads an empty library as an invitation, with nothing to clear", () => {
    const html = renderToStaticMarkup(createElement(DeckResultsEmpty, { query: "" }));
    expect(html).toContain("No presentations yet");
    expect(html).not.toContain("Clear search");
  });

  it("renders the whole screen with no decks, without the tools there is nothing to use on", () => {
    const html = renderToStaticMarkup(createElement(DeckLibraryScreen, { onOpen: vi.fn() }));
    expect(html).toContain("songs-teacher");
    expect(html).toContain("beautiful presentations");
    expect(html).toContain("No presentations yet");
    expect(html).not.toContain("Search presentations");
    expect(html).not.toContain("MusicSlides");
  });
});

describe("the bottom nav", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("has the four agreed items and nothing that goes nowhere", () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual(["Presentations", "Chord & Tabs", "Song Study Tools", "Library"]);
  });

  it("gives every item its own destination, with a section rendered for it", () => {
    const sections = NAV_ITEMS.map((n) => n.section);
    expect(new Set(sections).size).toBe(4);
    for (const section of sections) expect(app).toMatch(new RegExp(`section\\(\\s*"${section}"`));
  });
});

describe("the screen's source", () => {
  const screen = readFileSync(new URL("./DeckLibraryScreen.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("never filters inside a Zustand selector, which re-renders forever", () => {
    expect(screen).not.toMatch(/useDeckStore\(\(s\) => [^)]*(filter|sort|map)\(/);
  });

  it("has no colour of its own: everything comes from a token", () => {
    expect(screen).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("gives what wraps a slide no transform and no transition", () => {
    const rules = [...css.matchAll(/([^{}]*\.(?:deck-row|deck-card|deck-thumb|row)\b[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(3);
    for (const [, selector, body] of rules) {
      if (selector!.includes("::")) continue;
      expect(`${selector}{${body}}`).not.toMatch(/(?<![-\w])transform:|transition|filter:/);
    }
  });

  it("makes dropping in a photo one line: the backdrop reads a token, and the scrim sits over it", () => {
    expect(css).toMatch(/--hero-photo:\s*none/);
    expect(css).toMatch(/\.hero-photo \{[^}]*var\(--hero-photo\)/);
    expect(css.indexOf(".hero-scrim {")).toBeGreaterThan(-1);
    expect(screen.indexOf("hero-photo")).toBeLessThan(screen.indexOf("hero-scrim"));
  });
});
