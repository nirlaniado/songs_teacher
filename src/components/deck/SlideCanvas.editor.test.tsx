// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SLIDE_H, SLIDE_W, Slide, type SlideElement } from "../../schema/deck.js";
import { useDeckStore } from "../../store/deckStore.js";
import { computed, installAppCss, openDeck, stubResizeObserver } from "../../test/dom.js";
import { SlideCanvas } from "./SlideCanvas.js";

// The inline editor overlay, mounted for real and driven the way a user drives it. CLAUDE.md's Traps
// section is its contract; each test below names the trap it guards.
//
// jsdom does no layout, so a textarea's scrollHeight/scrollWidth are always 0. The overlay's sizing
// depends on them, so they are STUBBED below with a model of a real textarea: a fixed line height and
// character width, and — like a browser — reporting only the box's own size once content fits in it,
// unless collapsed first (height "auto", width "1px"). What these tests check is the overlay's response
// to those measurements, not a browser's layout.
const LINE = 40;
const CHAR = 12;
const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : 0);
const natural = (field: HTMLTextAreaElement) => {
  const lines = field.value.split("\n");
  return { h: lines.length * LINE, w: Math.max(...lines.map((l) => l.length)) * CHAR };
};
const proto = HTMLTextAreaElement.prototype;
const saved = {
  h: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!,
  w: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!,
};

beforeAll(async () => {
  stubResizeObserver();
  await installAppCss();
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) { const n = natural(this).h; return this.style.height === "auto" ? n : Math.max(n, px(this.style.height)); },
  });
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get(this: HTMLTextAreaElement) { const n = natural(this).w; return this.style.width === "1px" ? n : Math.max(n, px(this.style.width)); },
  });
});
afterAll(() => {
  Object.defineProperty(proto, "scrollHeight", saved.h);
  Object.defineProperty(proto, "scrollWidth", saved.w);
});
afterEach(cleanup);

const ID = "00000000-0000-4000-8000-0000000000e1";
function text(over: Partial<Extract<SlideElement, { kind: "text" }>> = {}) {
  return { kind: "text", id: ID, x: 100, y: 100, w: 600, h: 120, text: "Verse one", role: "body", ...over };
}
function tab(over: Record<string, unknown> = {}) {
  return { kind: "tab", id: ID, x: 100, y: 100, w: 200, h: 120, text: "e|-------\nB|-------\nG|-------", ...over };
}

/** Mounts the canvas on a slide holding `element`, and opens it for editing as a double-click does. */
function edit(element: object) {
  openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [element] })]);
  render(<SlideCanvas />);
  act(() => useDeckStore.getState().setEditingElement(ID));
  const field = document.querySelector("textarea")!;
  expect(field).not.toBeNull();
  return { field, box: field.parentElement! };
}
const type = (field: HTMLTextAreaElement, value: string) => fireEvent.change(field, { target: { value } });
const textNow = () => (useDeckStore.getState().deck!.slides[0]!.elements[0] as { text: string }).text;
/** Divs, outside the editor, that draw `needle` as their own text. */
const drawn = (needle: string) =>
  [...document.querySelectorAll("div")].filter((d) => [...d.childNodes].some((n) => n.nodeType === 3 && n.textContent!.includes(needle)));

describe("the inline editor hides the element it edits (hiddenElementIds)", () => {
  it.each([["text", text()], ["tab", tab()]])("draws a %s once, in the field, not again underneath it", (_kind, element) => {
    const needle = (element as { text: string }).text.split("\n")[0]!;
    openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [element] })]);
    render(<SlideCanvas />);
    expect(drawn(needle).length).toBeGreaterThan(0);
    act(() => useDeckStore.getState().setEditingElement(ID));
    expect(document.querySelector("textarea")!.value).toContain(needle);
    expect(drawn(needle)).toEqual([]);
  });
});

describe("the inline editor aligns text the way the renderer does (justifyContent)", () => {
  it.each(["top", "middle", "bottom"] as const)("valign %s", (valign) => {
    openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [text({ style: { valign } } as never)] })]);
    render(<SlideCanvas />);
    const [view] = drawn("Verse one").filter((d) => d.style.left === "100px");
    const rendered = getComputedStyle(view!).justifyContent;
    act(() => useDeckStore.getState().setEditingElement(ID));
    const box = document.querySelector("textarea")!.parentElement!;
    expect(getComputedStyle(box).justifyContent).toBe(rendered);
    expect(getComputedStyle(box).display).toBe("flex");
  });
});

describe("the inline editor grows past the element's saved height (editorBoxHeight)", () => {
  it("shows every line of text taller than the box", () => {
    const { field, box } = edit(text());
    type(field, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    expect(box.style.height).toBe(`${10 * LINE}px`);
    expect(field.style.height).toBe(`${10 * LINE}px`);
  });

  it("stops at the slide's bottom edge and scrolls the rest, keeping the field at its own size", () => {
    const { field, box } = edit(text({ y: 500 }));
    type(field, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    expect(box.style.height).toBe(`${SLIDE_H - 500}px`);
    expect(box.style.overflow).toBe("auto");
    expect(field.style.height).toBe(`${10 * LINE}px`);
  });

  it("goes back to the saved height when the text is short again", () => {
    const { field, box } = edit(text());
    type(field, "a\nb\nc\nd\ne\nf");
    type(field, "short");
    expect(box.style.height).toBe("120px");
  });
});

describe("a tab's editor grows past the element's saved width (editorBoxWidth)", () => {
  const long = "e|" + "-".repeat(98);

  it("shows a line longer than the box, and shrinks back when it is shortened", () => {
    const { field, box } = edit(tab({ x: 100, w: 200 }));
    type(field, `${long}\nB|---`);
    expect(field.style.width).toBe(`${long.length * CHAR}px`);
    expect(box.style.width).toBe(`${Math.min(SLIDE_W - 100, long.length * CHAR)}px`);
    type(field, "e|---\nB|---");
    expect(field.style.width).toBe("200px");
    expect(box.style.width).toBe("200px");
  });

  it("leaves a text element's width alone, since text wraps", () => {
    const { field, box } = edit(text());
    type(field, "x".repeat(200));
    expect(field.style.width).toBe("100%");
    expect(box.style.width).toBe("600px");
  });
});

describe("inserting a bend leaves the tab visible, with the caret after the insert (#33)", () => {
  const caretAt = (field: HTMLTextAreaElement, line: number, col: number) => {
    const at = field.value.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
    field.focus();
    field.setSelectionRange(at, at);
    return at;
  };
  const visible = (field: HTMLTextAreaElement) => {
    const { h, w } = natural(field);
    expect(field.style.width).toBe(`${Math.max(200, w)}px`);
    expect(field.style.height).toBe(`${h}px`);
  };

  it("from a preset", () => {
    const { field } = edit(tab());
    const at = caretAt(field, 1, 4);
    fireEvent.click(screen.getByRole("button", { name: "Half-step bend (1/2)" }));
    expect(textNow()).toBe("e|-------\nB|--1/2-----\nG|-------");
    expect(field.value).toBe(textNow());
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(at + 3);
    visible(field);
  });

  it("from the custom amount field", () => {
    const { field } = edit(tab());
    const at = caretAt(field, 2, 3);
    const amount = screen.getByRole("textbox", { name: "Bend amount" });
    act(() => amount.focus());
    expect(document.querySelector("textarea")).toBe(field);
    fireEvent.change(amount, { target: { value: "1/4" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert bend amount" }));
    expect(textNow()).toBe("e|-------\nB|-------\nG|-1/4------");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(at + 3);
    visible(field);
  });

  it("and plain typing keeps it visible too", () => {
    const { field } = edit(tab());
    type(field, "e|--3----\nB|-------\nG|-------");
    visible(field);
  });
});

describe("the inline editor stays out of the control layer", () => {
  it("is a plain textarea with no control classes", () => {
    const { field, box } = edit(text());
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.getAttribute("class")).toBeNull();
    expect(box.getAttribute("class")).toBeNull();
  });

  it("shows its own outline ring, and no focus ring on the field even while focused", () => {
    const { field, box } = edit(text());
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(getComputedStyle(field).outlineStyle).toBe("none");
    expect(box.style.outline).toMatch(/solid var\(--color-accent\)/);
  });

  it("has no motion", () => {
    const { field, box } = edit(text());
    const plain = computed(document.body.appendChild(document.createElement("div")));
    const plainField = computed(document.body.appendChild(document.createElement("textarea")));
    const motion = (style: Record<string, string>, base: Record<string, string>) =>
      Object.keys(style).filter((p) => /^(transition|animation|transform|scale|translate|rotate)/.test(p) && style[p] !== base[p]).map((p) => `${p}: ${style[p]}`);
    expect(motion(computed(box), plain)).toEqual([]);
    expect(motion(computed(field), plainField)).toEqual([]);
  });
});
