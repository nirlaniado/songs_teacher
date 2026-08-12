import { beforeEach, describe, expect, it } from "vitest";
import { newDeck, type Slide, type SlideElement } from "../schema/deck.js";
import { arrange, useDeckStore } from "./deckStore.js";

/**
 * The editing commands mirrored from Impress.
 *
 * Everything here is reachable three ways — toolbar, context menu, keyboard —
 * so the behaviour is pinned in the store rather than in any one of them.
 */

function box(id: string, x = 0, y = 0, w = 100, h = 100): SlideElement {
  return { id, kind: "shape", x, y, w, h, rotation: 0, locked: false, shape: "rect", strokeWidth: 0 };
}

/** Opens a one-slide deck holding exactly these elements. */
function openWith(elements: SlideElement[]): void {
  const deck = newDeck({ id: crypto.randomUUID(), title: "Test" });
  const slide: Slide = { id: crypto.randomUUID(), name: "S", layout: "blank", elements };
  useDeckStore.setState({
    deck: { ...deck, slides: [slide] },
    currentSlide: 0,
    selectedElementIds: [],
    editingElementId: null,
    clipboard: [],
    pasteCount: 0,
    past: [],
    future: [],
  });
}

const ids = () => useDeckStore.getState().deck!.slides[0]!.elements.map((el) => el.id);
const elementsNow = () => useDeckStore.getState().deck!.slides[0]!.elements;
const byId = (id: string) => elementsNow().find((el) => el.id === id)!;

describe("arrange", () => {
  const list = [box("a"), box("b"), box("c"), box("d")];

  it("jumps all the way with front and back", () => {
    expect(arrange(list, ["a"], "front").map((el) => el.id)).toEqual(["b", "c", "d", "a"]);
    expect(arrange(list, ["d"], "back").map((el) => el.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("steps one position with forward and backward", () => {
    expect(arrange(list, ["b"], "forward").map((el) => el.id)).toEqual(["a", "c", "b", "d"]);
    expect(arrange(list, ["c"], "backward").map((el) => el.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(arrange(list, ["d"], "forward").map((el) => el.id)).toEqual(["a", "b", "c", "d"]);
    expect(arrange(list, ["a"], "backward").map((el) => el.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a multi-selection as a block, keeping its internal order", () => {
    // Stepping each element independently collapses the block onto itself,
    // which silently reshuffles a group the user arranged deliberately.
    expect(arrange(list, ["a", "b"], "forward").map((el) => el.id)).toEqual(["c", "a", "b", "d"]);
    expect(arrange(list, ["c", "d"], "backward").map((el) => el.id)).toEqual(["a", "c", "d", "b"]);
    expect(arrange(list, ["a", "c"], "front").map((el) => el.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("selection", () => {
  beforeEach(() => openWith([box("a"), box("b"), box("c")]));

  it("replaces on a plain select and extends on a toggle", () => {
    const store = useDeckStore.getState();
    store.selectElement(ids()[0]!);
    expect(useDeckStore.getState().selectedElementIds).toEqual([ids()[0]]);

    store.toggleElementSelection(ids()[1]!);
    expect(useDeckStore.getState().selectedElementIds).toHaveLength(2);

    store.toggleElementSelection(ids()[1]!);
    expect(useDeckStore.getState().selectedElementIds).toEqual([ids()[0]]);
  });

  it("collapses to one element when text editing starts", () => {
    // The properties panel and every command would otherwise still aim at a
    // group while the user types into one member of it.
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.setEditingElement(ids()[2]!);
    expect(useDeckStore.getState().selectedElementIds).toEqual([ids()[2]]);
  });

  it("selects everything on the current slide", () => {
    useDeckStore.getState().selectAllElements();
    expect(useDeckStore.getState().selectedElementIds).toEqual(ids());
  });
});

describe("clipboard", () => {
  beforeEach(() => openWith([box("a", 100, 100), box("b", 300, 300)]));

  it("pastes copies with fresh ids, offset and selected", () => {
    const store = useDeckStore.getState();
    const [first] = ids();
    store.selectElement(first!);
    store.copySelection();
    store.pasteClipboard();

    expect(elementsNow()).toHaveLength(3);
    const pasted = elementsNow().at(-1)!;
    // Duplicate ids break selection and z-ordering, both of which address
    // elements by id.
    expect(pasted.id).not.toBe(first);
    expect(pasted.x).toBeGreaterThan(100);
    expect(useDeckStore.getState().selectedElementIds).toEqual([pasted.id]);
  });

  it("cascades repeated pastes so copies don't stack invisibly", () => {
    const store = useDeckStore.getState();
    store.selectElement(ids()[0]!);
    store.copySelection();
    store.pasteClipboard();
    const firstPaste = elementsNow().at(-1)!.x;
    useDeckStore.getState().pasteClipboard();
    expect(elementsNow().at(-1)!.x).toBeGreaterThan(firstPaste);
  });

  it("survives edits to the original between copy and paste", () => {
    const store = useDeckStore.getState();
    const [first] = ids();
    store.selectElement(first!);
    store.copySelection();
    useDeckStore.getState().updateElement(first!, (el) => ({ ...el, x: 999 }));
    useDeckStore.getState().pasteClipboard();
    // The clipboard is a deep clone, so it holds what was copied, not a live
    // view of an element that has since moved.
    expect(elementsNow().at(-1)!.x).toBe(100 + 24);
  });

  it("cut removes the originals and keeps them pasteable", () => {
    const store = useDeckStore.getState();
    store.selectElement(ids()[0]!);
    store.cutSelection();
    expect(elementsNow()).toHaveLength(1);
    useDeckStore.getState().pasteClipboard();
    expect(elementsNow()).toHaveLength(2);
  });

  it("duplicate selects the copies, so Ctrl+D repeats into a row", () => {
    const store = useDeckStore.getState();
    store.selectElement(ids()[0]!);
    store.duplicateSelection();
    const afterFirst = useDeckStore.getState().selectedElementIds;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).not.toBe(ids()[0]);

    useDeckStore.getState().duplicateSelection();
    expect(elementsNow()).toHaveLength(4);
  });

  it("pastes nothing when the clipboard is empty", () => {
    useDeckStore.getState().pasteClipboard();
    expect(elementsNow()).toHaveLength(2);
  });
});

describe("align and distribute", () => {
  it("aligns several elements to each other", () => {
    openWith([box("a", 100, 100), box("b", 400, 300), box("c", 700, 500)]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.alignSelection("left");
    expect(elementsNow().map((el) => el.x)).toEqual([100, 100, 100]);
  });

  it("aligns a lone element to the slide, so 'centre' is not a no-op", () => {
    openWith([box("a", 0, 0, 400, 200)]);
    const store = useDeckStore.getState();
    store.selectElement(ids()[0]!);
    store.alignSelection("center");
    expect(byId(ids()[0]!).x).toBe((1280 - 400) / 2);
  });

  it("leaves locked elements where they are", () => {
    // Locking exists precisely so a bulk command can't move something pinned.
    openWith([box("a", 100, 100), { ...box("b", 400, 300), locked: true }]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.alignSelection("left");
    expect(byId(ids()[1]!).x).toBe(400);
  });

  it("spaces the middle elements evenly and leaves the outer two", () => {
    openWith([box("a", 0, 0), box("b", 30, 0), box("c", 400, 0)]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.distributeSelection("horizontal");
    expect(elementsNow().map((el) => el.x)).toEqual([0, 200, 400]);
  });

  it("refuses to distribute fewer than three", () => {
    // Two elements are the span itself; there is nothing in between to space.
    openWith([box("a", 0, 0), box("b", 30, 0)]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.distributeSelection("horizontal");
    expect(elementsNow().map((el) => el.x)).toEqual([0, 30]);
  });
});

describe("bulk edits and history", () => {
  beforeEach(() => openWith([box("a", 100, 100), box("b", 300, 300), box("c", 500, 500)]));

  it("moves a whole selection in one undo step", () => {
    const store = useDeckStore.getState();
    store.selectElements(ids().slice(0, 2));
    store.nudgeSelection(10, 20);

    expect(byId(ids()[0]!).x).toBe(110);
    expect(byId(ids()[1]!).y).toBe(320);
    expect(byId(ids()[2]!).x).toBe(500);

    // One commit for the batch — three separate ones would cost three undos
    // for a single gesture.
    useDeckStore.getState().undo();
    expect(byId(ids()[0]!).x).toBe(100);
  });

  it("deletes a selection but spares locked members", () => {
    openWith([box("a"), { ...box("b"), locked: true }]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.deleteSelection();
    expect(elementsNow()).toHaveLength(1);
    expect(elementsNow()[0]!.locked).toBe(true);
  });

  it("drops a deleted element from the selection", () => {
    const store = useDeckStore.getState();
    store.selectElements(ids());
    const target = ids()[1]!;
    store.deleteElement(target);
    expect(useDeckStore.getState().selectedElementIds).not.toContain(target);
    expect(useDeckStore.getState().selectedElementIds).toHaveLength(2);
  });
});

describe("view state", () => {
  it("is not deck data — toggling it never dirties the document", () => {
    // Same rule as the stem mixer: a rehearsal or view setting is not a
    // property of the presentation.
    openWith([box("a")]);
    useDeckStore.setState({ savedSnapshot: JSON.stringify(useDeckStore.getState().deck) });
    const store = useDeckStore.getState();
    store.toggleGrid();
    store.toggleSnap();
    store.setZoom(2);
    expect(useDeckStore.getState().isDirty()).toBe(false);
    expect(useDeckStore.getState().past).toHaveLength(0);
  });
});

describe("tab elements", () => {
  it("adds one through the same generic path every element kind uses", () => {
    // The actual code the toolbar's "+ Tab" button runs — proves the store's
    // addElement doesn't special-case away a new SlideElement variant.
    openWith([]);
    const store = useDeckStore.getState();
    store.addElement({
      kind: "tab",
      x: 40,
      y: 40,
      w: 400,
      h: 160,
      rotation: 0,
      locked: false,
      text: "",
      style: { fontSize: 20, valign: "top", lineHeight: 1.3 },
    });

    expect(elementsNow()).toHaveLength(1);
    const tab = elementsNow()[0]!;
    expect(tab.kind).toBe("tab");
    // addElement selects what it just created, same as text/image/shape.
    expect(useDeckStore.getState().selectedElementIds).toEqual([tab.id]);
  });

  it("edits verbatim through updateElement, with no parsing of the content", () => {
    openWith([
      { id: crypto.randomUUID(), kind: "tab", x: 0, y: 0, w: 400, h: 160, rotation: 0, locked: false, text: "", style: { fontSize: 20, valign: "top", lineHeight: 1.3 } },
    ]);
    const tabId = ids()[0]!;
    const raw = "e|--0---2---3---|\nB|--1---3---0---|";
    useDeckStore.getState().updateElement(tabId, (el) => (el.kind === "tab" ? { ...el, text: raw } : el));
    const updated = byId(tabId);
    expect(updated.kind === "tab" && updated.text).toBe(raw);
  });

  it("participates in arrange/align/clipboard like any other element", () => {
    // Those commands only touch Box fields (x/y/w/h/rotation/locked), so a
    // new kind needs no special-casing there — this pins that it actually
    // doesn't, rather than assuming it from reading the code.
    openWith([
      box("a", 100, 100),
      { id: crypto.randomUUID(), kind: "tab", x: 400, y: 300, w: 300, h: 120, rotation: 0, locked: false, text: "x32010", style: { fontSize: 20, valign: "top", lineHeight: 1.3 } },
    ]);
    const store = useDeckStore.getState();
    store.selectElements(ids());
    store.alignSelection("left");
    expect(elementsNow().map((el) => el.x)).toEqual([100, 100]);

    store.selectElement(ids()[1]!);
    store.duplicateSelection();
    expect(elementsNow()).toHaveLength(3);
    expect(elementsNow().at(-1)!.kind).toBe("tab");
  });
});
