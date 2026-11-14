import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newDeck, type Deck, type DeckSummary, type Slide, type SlideElement } from "../schema/deck.js";
import { arrange, useDeckStore } from "./deckStore.js";
import type { LibraryAdapter } from "../adapters/types.js";
import type { ChordResult } from "../ug/types.js";
import { cuesForAudio } from "../audio/autoCue.js";

// Audio decoding needs a browser; the analysis itself is tested in segment.test.ts.
vi.mock("../audio/autoCue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audio/autoCue.js")>()),
  cuesForAudio: vi.fn(),
}));

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

  describe("the library's view mode", () => {
    function fakeStorage() {
      const saved = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
      });
    }

    afterEach(() => vi.unstubAllGlobals());

    it("never dirties or reaches the document", () => {
      fakeStorage();
      openWith([box("a")]);
      useDeckStore.setState({ savedSnapshot: JSON.stringify(useDeckStore.getState().deck) });
      useDeckStore.getState().setLibraryView("grid");
      expect(useDeckStore.getState().isDirty()).toBe(false);
      expect(useDeckStore.getState().past).toHaveLength(0);
      expect(JSON.stringify(useDeckStore.getState().deck)).not.toContain("grid");
      useDeckStore.getState().setLibraryView("list");
    });

    it("survives a reload, which is a fresh store reading what the last one saved", async () => {
      fakeStorage();
      useDeckStore.getState().setLibraryView("grid");
      vi.resetModules();
      const reloaded = await import("./deckStore.js");
      expect(reloaded.useDeckStore.getState().libraryView).toBe("grid");
      useDeckStore.getState().setLibraryView("list");
    });

    it("defaults to list, the mockup's selected state, and ignores anything else saved", async () => {
      fakeStorage();
      localStorage.setItem("songs-teacher.library-view", "carousel");
      vi.resetModules();
      expect((await import("./deckStore.js")).useDeckStore.getState().libraryView).toBe("list");
    });

    it("still holds the choice when storage is refused", () => {
      vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("denied"); } });
      useDeckStore.getState().setLibraryView("grid");
      expect(useDeckStore.getState().libraryView).toBe("grid");
      useDeckStore.getState().setLibraryView("list");
    });
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

/** A minimal in-memory LibraryAdapter — just enough for writeDeck/readDeck/listDecks. */
function fakeAdapter(): LibraryAdapter {
  const decks = new Map<string, Deck>();
  const notImplemented = () => Promise.reject(new Error("not implemented in fakeAdapter"));
  return {
    kind: "indexeddb",
    isAttached: () => true,
    attach: () => Promise.resolve(true),
    restore: () => Promise.resolve(true),
    detach: () => Promise.resolve(),
    listSongs: notImplemented,
    readSong: notImplemented,
    writeSong: notImplemented,
    deleteSong: notImplemented,
    resolveAudio: notImplemented,
    readAsset: notImplemented,
    writeAsset: notImplemented,
    async listDecks() {
      return [...decks.values()].map(
        (d): DeckSummary => ({
          id: d.id,
          title: d.title,
          slideCount: d.slides.length,
          hasAudio: d.audio !== undefined,
          updatedAt: d.updatedAt,
        }),
      );
    },
    async readDeck(id) {
      const deck = decks.get(id);
      if (!deck) throw new Error(`no such deck: ${id}`);
      return deck;
    },
    async writeDeck(deck) {
      decks.set(deck.id, deck);
      return deck;
    },
    deleteDeck: notImplemented,
    readDeckAsset: notImplemented,
    writeDeckAsset: () => Promise.resolve(),
    resolveDeckMedia: notImplemented,
  };
}

function chordResult(overrides: Partial<ChordResult> = {}): ChordResult {
  return {
    source: {
      id: "1",
      title: "Viva La Vida",
      artist: "Coldplay",
      url: "https://tabs.ultimate-guitar.com/example",
      official: true,
      version: 1,
      views: 100000,
    },
    retrievedAt: "2026-01-01T00:00:00.000Z",
    selection: "official",
    warning: null,
    capo: null,
    tuning: null,
    key: null,
    lines: [{ section: "Verse 1", sourceLine: 0, chords: ["G", "D"], row: "G   D", lyric: "hello darkness my old friend" }],
    uniqueChords: ["G", "D"],
    chart: "",
    ...overrides,
  };
}

describe("createDeckFromChords", () => {
  const song = () => new File(["x"], "song.mp3", { type: "audio/mpeg" });

  beforeEach(() => {
    useDeckStore.setState({ adapter: fakeAdapter(), deck: null, decks: [], error: null });
    vi.mocked(cuesForAudio).mockReset();
  });

  it("saves a deck already synced to the song: audio attached, every slide cued", async () => {
    // Cover + the single "Verse 1" section = 2 slides.
    vi.mocked(cuesForAudio).mockResolvedValue({ times: [0, 12.5], source: "lyrics" });
    await useDeckStore.getState().createDeckFromChords(chordResult(), song());

    const { deck, error } = useDeckStore.getState();
    expect(error).toBeNull();
    expect(deck!.title).toBe("Viva La Vida — Coldplay");
    expect(deck!.audio?.path).toBe("audio.mp3");
    expect(deck!.audio?.originalName).toBe("song.mp3");
    expect(deck!.slides.map((s) => s.startTime)).toEqual([0, 12.5]);
    // The timing is given each section's name, chord-line count and lyrics — in slide order.
    expect(vi.mocked(cuesForAudio).mock.calls[0]![1]).toEqual([
      { name: "Title", lines: 0, lyrics: [] },
      { name: "Verse 1", lines: 1, lyrics: ["hello darkness my old friend"] },
    ]);
  });

  it("leaves slides uncued when the audio has fewer parts than the deck has slides", async () => {
    vi.mocked(cuesForAudio).mockResolvedValue({ times: [0, undefined], source: "lyrics" });
    await useDeckStore.getState().createDeckFromChords(chordResult(), song());
    expect(useDeckStore.getState().deck!.slides.map((s) => s.startTime)).toEqual([0, undefined]);
  });

  it("still creates the deck, uncued, and reports it when the analysis fails", async () => {
    vi.mocked(cuesForAudio).mockRejectedValue(new Error("Unable to decode audio data"));
    await useDeckStore.getState().createDeckFromChords(chordResult(), song());

    const { deck, error } = useDeckStore.getState();
    expect(deck).not.toBeNull();
    expect(deck!.audio?.originalName).toBe("song.mp3");
    expect(deck!.slides.every((s) => s.startTime === undefined)).toBe(true);
    expect(error).toContain("Auto-suggest cues");
  });

  it("keeps the music-only cues but says so when the lyric timing was unavailable", async () => {
    vi.mocked(cuesForAudio).mockResolvedValue({ times: [0, 9], source: "music", note: "The local service is not running" });
    await useDeckStore.getState().createDeckFromChords(chordResult(), song());
    const { deck, error } = useDeckStore.getState();
    expect(deck!.slides.map((s) => s.startTime)).toEqual([0, 9]);
    expect(error).toContain("music alone");
  });

  it("lists the new deck in the library after creating it", async () => {
    vi.mocked(cuesForAudio).mockResolvedValue({ times: [0, 10], source: "lyrics" });
    await useDeckStore.getState().createDeckFromChords(chordResult(), song());
    expect(useDeckStore.getState().decks.map((d) => d.title)).toContain("Viva La Vida — Coldplay");
  });
});

describe("setSlideCues", () => {
  function openSlides(n: number) {
    const deck = newDeck({ id: crypto.randomUUID(), title: "T" });
    const slides: Slide[] = Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `S${i}`,
      layout: "blank",
      elements: [],
    }));
    useDeckStore.setState({ deck: { ...deck, slides }, past: [], future: [] });
  }
  const cues = () => useDeckStore.getState().deck!.slides.map((s) => s.startTime);

  it("sets every cue as one undo step", () => {
    openSlides(3);
    const ok = useDeckStore.getState().setSlideCues([
      { index: 0, seconds: 0 },
      { index: 1, seconds: 12 },
      { index: 2, seconds: 24 },
    ]);
    expect(ok).toBe(true);
    expect(cues()).toEqual([0, 12, 24]);
    expect(useDeckStore.getState().past).toHaveLength(1);

    useDeckStore.getState().undo();
    expect(cues()).toEqual([undefined, undefined, undefined]);
  });

  it("refuses a batch that would run backwards and changes nothing", () => {
    openSlides(2);
    const ok = useDeckStore.getState().setSlideCues([
      { index: 0, seconds: 30 },
      { index: 1, seconds: 10 },
    ]);
    expect(ok).toBe(false);
    expect(cues()).toEqual([undefined, undefined]);
    expect(useDeckStore.getState().past).toHaveLength(0);
  });

  it("can clear cues by passing undefined", () => {
    openSlides(2);
    useDeckStore.getState().setSlideCues([{ index: 0, seconds: 0 }, { index: 1, seconds: 5 }]);
    useDeckStore.getState().setSlideCues([{ index: 1, seconds: undefined }]);
    expect(cues()).toEqual([0, undefined]);
  });
});
