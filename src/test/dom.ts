// Test-only helpers for component tests that run under `// @vitest-environment jsdom`.
// jsdom does selector matching, the cascade, inheritance and `::after`, but no layout and no painting:
// anything measured (scrollWidth/scrollHeight, getBoundingClientRect) is zero unless a test stubs it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { newDeck, type Slide, type Theme } from "../schema/deck.js";
import type { LibraryAdapter } from "../adapters/types.js";
import { useDeckStore } from "../store/deckStore.js";

let built: Promise<string> | undefined;

/** The app's stylesheet as the build ships it: index.css through Tailwind, with every class used under src. */
export function appCss(): Promise<string> {
  built ??= (async () => {
    const src = resolve("src");
    const compiler = await compile(readFileSync(resolve(src, "index.css"), "utf8"), { base: src, from: resolve(src, "index.css"), onDependency: () => {} });
    const candidates = new Scanner({ sources: [{ base: src, pattern: "**/*", negated: false }] }).scan();
    return compiler.build(candidates);
  })();
  return built;
}

export async function installAppCss() {
  const style = document.createElement("style");
  style.textContent = await appCss();
  document.head.append(style);
  return style;
}

/** jsdom has no ResizeObserver or URL.revokeObjectURL; the canvas refit and asset cleanup aren't what these test. */
export function stubResizeObserver() {
  URL.revokeObjectURL ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/** Opens a deck in the store, with an adapter that resolves every media path to a fixed URL. */
export function openDeck(slides: Slide[], theme?: Theme) {
  const base = newDeck({ id: "00000000-0000-4000-8000-0000000000d0", title: "Test" });
  const deck = { ...base, theme: theme ?? base.theme, slides };
  const adapter = {
    resolveDeckMedia: async (_deck: string, path: string) => ({ url: `blob:test/${path}`, release() {} }),
    readDeck: async () => deck,
  } as unknown as LibraryAdapter;
  useDeckStore.setState({
    adapter,
    deck,
    currentSlide: 0,
    selectedElementIds: [],
    editingElementId: null,
    clipboard: [],
    pasteCount: 0,
    past: [],
    future: [],
  });
  return deck;
}

/** Every computed property jsdom reports for an element, as a plain map. */
export function computed(el: Element, pseudo?: string): Record<string, string> {
  const style = getComputedStyle(el, pseudo);
  const out: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    out[name] = style.getPropertyValue(name);
  }
  return out;
}

/** The renderer's inner 1280×720 layer: the one element sized in slide units and scaled to fit. */
export function slideLayers(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("div")].filter((d) => d.style.width === "1280px" && d.style.transform.startsWith("scale("));
}

type Node = { path: string; style: Record<string, string> };

/**
 * Computed styles for a mounted slide: SlideRenderer's outer surface (its on-screen size, and whatever a
 * mount's stylesheet does to it), the inner 1280×720 layer (with its scale transform), and the slide's own
 * content — the first `count` children of the layer and everything inside them. Each of those nodes also
 * contributes its `::before` and `::after`, since a mount's rule can draw through a pseudo-element without
 * touching the node's own style. Editor chrome, which the canvas adds after the content, is not compared.
 */
export function slideStyles(layer: HTMLElement, count: number): Node[] {
  const out: Node[] = [];
  const add = (el: Element, path: string) => {
    out.push({ path, style: computed(el) });
    for (const pseudo of ["::before", "::after"]) out.push({ path: path + pseudo, style: computed(el, pseudo) });
  };
  add(layer.parentElement!, "surface");
  add(layer, "layer");
  const walk = (el: Element, path: string) => {
    add(el, path);
    [...el.children].forEach((child, i) => walk(child, `${path}>${child.tagName.toLowerCase()}[${i}]`));
  };
  [...layer.children].slice(0, count).forEach((child, i) => walk(child, `layer>${child.tagName.toLowerCase()}[${i}]`));
  return out;
}

/** The slide's on-screen size and scale, as rendered: surface width × height, and the layer's transform. */
export function slideScale(layer: HTMLElement) {
  const surface = getComputedStyle(layer.parentElement!);
  return { width: surface.width, height: surface.height, transform: getComputedStyle(layer).transform };
}
/**
 * Where `got` would look different from `reference`, as "path property: before -> after".
 *
 * A mount's ancestors pass inherited properties down, and some cannot change how this content looks:
 * `pointer-events` and `cursor` are interaction, not appearance; `list-style-*` only draws on list items,
 * which is checked here rather than assumed. One custom property is excused by name: `--row-wash`, which the
 * library's clickable row sets for its own hover wash and nothing in a slide reads. Any other custom property
 * that differs is reported, because a rule can read one in a pseudo-element or anywhere else (#47).
 * `text-align` is not excused: the rail's <button> once centred a tab's text through it, which SlideRenderer
 * now pins at its root.
 */
export function appearanceDifferences(reference: Node[], got: Node[]): string[] {
  const out: string[] = [];
  if (reference.length !== got.length) return [`${reference.length} nodes -> ${got.length}`];
  reference.forEach((r, i) => {
    const g = got[i]!;
    if (r.path !== g.path) return void out.push(`${r.path} -> ${g.path}`);
    for (const p of new Set([...Object.keys(r.style), ...Object.keys(g.style)])) {
      if (r.style[p] === g.style[p]) continue;
      if (p === "pointer-events" || p === "cursor") continue;
      if (p === "--row-wash") continue;
      if (p.startsWith("list-style") && g.style.display !== "list-item") continue;
      out.push(`${r.path} ${p}: ${r.style[p]} -> ${g.style[p]}`);
    }
  });
  return out;
}
