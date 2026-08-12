import { describe, expect, it } from "vitest";
import { Deck, DECK_SCHEMA_VERSION, type Slide } from "../schema/deck.js";
import { applyOps, validateOps } from "./apply.js";
import type { Op } from "./ops.js";

const uuid = () => crypto.randomUUID();

function deckOf(names: string[], over: Partial<Slide>[] = []) {
  const now = new Date().toISOString();
  return Deck.parse({
    schemaVersion: DECK_SCHEMA_VERSION,
    id: uuid(),
    title: "Test",
    slides: names.map((name, i) => ({ id: uuid(), name, ...over[i] })),
    createdAt: now,
    updatedAt: now,
  });
}

/** Text of a slide's placeholder for a given role, or "" when absent. */
function roleText(slide: Slide, role: "title" | "body"): string {
  const el = slide.elements.find(
    (e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text" && e.role === role,
  );
  return el?.text ?? "";
}

const SONG = ["Intro", "Verse 1", "Chorus", "Verse 2"];

describe("createSlides", () => {
  it("appends slides titled and named from the spec", () => {
    const { deck } = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Intro" }, { title: "Verse 1" }] },
    ]);
    expect(deck.slides.map((s) => s.name)).toEqual(["Intro", "Verse 1"]);
    expect(roleText(deck.slides[0]!, "title")).toBe("Intro");
  });

  it("inserts at a position when given one", () => {
    const { deck } = applyOps(deckOf(["A", "B"]), [
      { op: "createSlides", slides: [{ title: "Mid" }], at: 1 },
    ]);
    expect(deck.slides.map((s) => s.name)).toEqual(["A", "Mid", "B"]);
  });

  it("carries optional body text onto the new slide", () => {
    const { deck } = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Verse 1", body: "C D E F" }] },
    ]);
    expect(roleText(deck.slides[0]!, "body")).toBe("C D E F");
  });

  it("produces a deck that still validates", () => {
    const { deck } = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "A" }, { title: "B" }] },
    ]);
    expect(Deck.safeParse(deck).success).toBe(true);
  });
});

describe("text ops", () => {
  it("appendBody keeps existing text and adds a line", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Verse 1", body: "first" }] },
    ]).deck;
    const { deck } = applyOps(base, [
      { op: "appendBody", target: { by: "all" }, text: "second" },
    ]);
    expect(roleText(deck.slides[0]!, "body")).toBe("first\nsecond");
  });

  it("setBody replaces instead of appending", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Verse 1", body: "first" }] },
    ]).deck;
    const { deck } = applyOps(base, [{ op: "setBody", target: { by: "all" }, text: "only" }]);
    expect(roleText(deck.slides[0]!, "body")).toBe("only");
  });

  it("adds a frame when the layout has no placeholder for that role", () => {
    // A blank slide has no title frame; setTitle must still land somewhere
    // visible rather than silently doing nothing.
    const blank = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "x", layout: "blank" }] },
    ]).deck;
    expect(blank.slides[0]!.elements).toHaveLength(0);
    const { deck } = applyOps(blank, [
      { op: "setTitle", target: { by: "all" }, text: "Now titled" },
    ]);
    expect(roleText(deck.slides[0]!, "title")).toBe("Now titled");
    expect(Deck.safeParse(deck).success).toBe(true);
  });

  it("touches only the targeted slides", () => {
    const base = deckOf(SONG);
    const { deck } = applyOps(base, [
      {
        op: "appendBody",
        target: { by: "nameOrdinal", base: "Verse", ordinals: [1, 2] },
        text: "C D",
      },
    ]);
    expect(roleText(deck.slides[1]!, "body")).toContain("C D");
    expect(roleText(deck.slides[3]!, "body")).toContain("C D");
    expect(roleText(deck.slides[0]!, "body")).toBe("");
    expect(roleText(deck.slides[2]!, "body")).toBe("");
  });
});

describe("structural ops", () => {
  it("renames one slide plainly", () => {
    const { deck } = applyOps(deckOf(SONG), [
      { op: "renameSlide", target: { by: "index", indexes: [0] }, name: "Opening" },
    ]);
    expect(deck.slides[0]!.name).toBe("Opening");
  });

  it("numbers a multi-slide rename so the results stay distinguishable", () => {
    const { deck } = applyOps(deckOf(["a", "b", "c"]), [
      { op: "renameSlide", target: { by: "all" }, name: "Part" },
    ]);
    expect(deck.slides.map((s) => s.name)).toEqual(["Part 1", "Part 2", "Part 3"]);
  });

  it("moves a slide", () => {
    const { deck } = applyOps(deckOf(["A", "B", "C"]), [{ op: "moveSlide", from: 0, to: 2 }]);
    expect(deck.slides.map((s) => s.name)).toEqual(["B", "C", "A"]);
  });

  it("ignores an out-of-range move rather than corrupting the deck", () => {
    const { deck } = applyOps(deckOf(["A", "B"]), [{ op: "moveSlide", from: 0, to: 9 }]);
    expect(deck.slides.map((s) => s.name)).toEqual(["A", "B"]);
  });

  it("deletes targeted slides", () => {
    const { deck } = applyOps(deckOf(SONG), [
      { op: "deleteSlides", target: { by: "family", base: "Verse" } },
    ]);
    expect(deck.slides.map((s) => s.name)).toEqual(["Intro", "Chorus"]);
  });

  it("changing layout preserves the title text", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Chorus", body: "keep me" }] },
    ]).deck;
    const { deck } = applyOps(base, [
      { op: "setLayout", target: { by: "all" }, layout: "titleTwoContent" },
    ]);
    expect(deck.slides[0]!.layout).toBe("titleTwoContent");
    expect(roleText(deck.slides[0]!, "title")).toBe("Chorus");
  });
});

describe("cue ops", () => {
  it("sets and clears cues", () => {
    const set = applyOps(deckOf(SONG), [
      { op: "setCue", target: { by: "index", indexes: [0] }, seconds: 0 },
      { op: "setCue", target: { by: "index", indexes: [1] }, seconds: 80 },
    ]).deck;
    expect(set.slides[0]!.startTime).toBe(0);
    expect(set.slides[1]!.startTime).toBe(80);

    const cleared = applyOps(set, [{ op: "clearCue", target: { by: "index", indexes: [1] } }]).deck;
    expect(cleared.slides[1]!.startTime).toBeUndefined();
  });
});

describe("design ops", () => {
  it("applies a theme preset by its id", () => {
    const { deck } = applyOps(deckOf(["A"]), [{ op: "setTheme", preset: "dark" }]);
    expect(deck.theme.preset).toBe("dark");
    expect(deck.theme.background).toEqual({ kind: "color", color: "#0f172a" });
  });

  it("applies a theme preset by its human label", () => {
    // A model is likelier to say "warm paper" than the id "paper".
    const { deck } = applyOps(deckOf(["A"]), [{ op: "setTheme", preset: "Warm Paper" }]);
    expect(deck.theme.preset).toBe("paper");
  });

  it("layers explicit colours over a preset and marks it custom", () => {
    const { deck } = applyOps(deckOf(["A"]), [
      { op: "setTheme", preset: "dark", accent: "#f97316" },
    ]);
    expect(deck.theme.text).toBe("#f1f5f9"); // from the preset
    expect(deck.theme.accent).toBe("#f97316"); // overridden
    expect(deck.theme.preset).toBe("custom");
  });

  it("ignores an unknown preset name rather than corrupting the theme", () => {
    const before = deckOf(["A"]);
    const { deck } = applyOps(before, [{ op: "setTheme", preset: "neon disco" }]);
    expect(deck.theme.background).toEqual(before.theme.background);
    expect(Deck.safeParse(deck).success).toBe(true);
  });

  it("sets and clears a per-slide background", () => {
    const set = applyOps(deckOf(SONG), [
      {
        op: "setSlideBackground",
        target: { by: "family", base: "Chorus" },
        color: "#112233",
      },
    ]).deck;
    expect(set.slides[2]!.background).toEqual({ kind: "color", color: "#112233" });
    expect(set.slides[0]!.background).toBeUndefined();

    const cleared = applyOps(set, [
      { op: "clearSlideBackground", target: { by: "all" } },
    ]).deck;
    expect(cleared.slides[2]!.background).toBeUndefined();
  });

  it("styles only the requested role", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Chorus", body: "words" }] },
    ]).deck;
    const { deck } = applyOps(base, [
      { op: "styleText", target: { by: "all" }, role: "title", color: "#f97316", bold: true },
    ]);
    const title = deck.slides[0]!.elements.find(
      (e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text" && e.role === "title",
    );
    const body = deck.slides[0]!.elements.find(
      (e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text" && e.role === "body",
    );
    expect(title?.style.color).toBe("#f97316");
    expect(title?.style.bold).toBe(true);
    expect(body?.style.color).toBeUndefined();
  });

  it("keeps the deck valid after design changes", () => {
    const { deck } = applyOps(deckOf(SONG), [
      { op: "setTheme", preset: "chalk" },
      { op: "setSlideBackground", target: { by: "all" }, color: "#000000" },
      { op: "styleText", target: { by: "all" }, role: "all", fontSize: 40 },
    ]);
    expect(Deck.safeParse(deck).success).toBe(true);
  });
});

describe("addImage", () => {
  it("adds an image element referencing an already-stored asset", () => {
    const { deck } = applyOps(deckOf(["Title"]), [
      { op: "addImage", target: { by: "all" }, src: "assets/cover-1.jpg" },
    ]);
    const image = deck.slides[0]!.elements.find((e) => e.kind === "image");
    expect(image).toBeDefined();
    expect(image!.kind === "image" && image!.src).toBe("assets/cover-1.jpg");
    expect(Deck.safeParse(deck).success).toBe(true);
  });

  it("defaults to a frame clear of the title and body placeholders", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Song", layout: "centered" }] },
    ]).deck;
    const { deck } = applyOps(base, [
      { op: "addImage", target: { by: "all" }, src: "assets/cover.jpg" },
    ]);
    const image = deck.slides[0]!.elements.find((e) => e.kind === "image")!;
    // Right half, and below every layout's body frame. The centered layout's
    // body runs full-width down to y=480, so a default any higher would land
    // on top of the subtitle text.
    expect(image.x).toBeGreaterThan(640);
    expect(image.y).toBeGreaterThanOrEqual(480);
    expect(image.x + image.w).toBeLessThanOrEqual(1280);
    expect(image.y + image.h).toBeLessThanOrEqual(720);
  });

  it("honours an explicit frame and fit", () => {
    const { deck } = applyOps(deckOf(["A"]), [
      {
        op: "addImage",
        target: { by: "all" },
        src: "assets/x.png",
        x: 10,
        y: 20,
        w: 100,
        h: 50,
        fit: "cover",
      },
    ]);
    const image = deck.slides[0]!.elements.find((e) => e.kind === "image")!;
    expect(image).toMatchObject({ x: 10, y: 20, w: 100, h: 50 });
    expect(image.kind === "image" && image.fit).toBe("cover");
  });

  it("keeps existing elements rather than replacing them", () => {
    const base = applyOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Song", body: "words" }] },
    ]).deck;
    const before = base.slides[0]!.elements.length;
    const { deck } = applyOps(base, [
      { op: "addImage", target: { by: "all" }, src: "assets/c.jpg" },
    ]);
    expect(deck.slides[0]!.elements).toHaveLength(before + 1);
  });
});

describe("arbitrary elements", () => {
  it("adds text boxes and shapes with explicit geometry", () => {
    const { deck } = applyOps(deckOf(["A"]), [
      {
        op: "addTextBox",
        target: { by: "all" },
        text: "Read me",
        x: 20,
        y: 30,
        w: 400,
        h: 90,
        rotation: 5,
        style: { bold: true, fontSize: 42 },
      },
      {
        op: "addShape",
        target: { by: "all" },
        shape: "ellipse",
        x: 500,
        y: 200,
        w: 180,
        h: 180,
        fill: "#ff0000",
      },
    ]);
    const [text, shape] = deck.slides[0]!.elements;
    expect(text).toMatchObject({ kind: "text", text: "Read me", x: 20, rotation: 5 });
    expect(text?.kind === "text" && text.style).toMatchObject({ bold: true, fontSize: 42 });
    expect(shape).toMatchObject({ kind: "shape", shape: "ellipse", fill: "#ff0000" });
    expect(Deck.safeParse(deck).success).toBe(true);
  });

  it("moves, resizes, rotates, locks, reorders, and removes elements by id", () => {
    const base = applyOps(deckOf(["A"]), [
      { op: "addTextBox", target: { by: "all" }, text: "one" },
      { op: "addShape", target: { by: "all" }, shape: "rect" },
    ]).deck;
    const [text, shape] = base.slides[0]!.elements;

    const transformed = applyOps(base, [
      {
        op: "updateElements",
        target: { by: "all" },
        elementIds: [text!.id],
        x: 250,
        w: 600,
        rotation: 25,
        locked: true,
      },
      {
        op: "reorderElement",
        target: { by: "all" },
        elementId: text!.id,
        direction: "front",
      },
    ]).deck;
    expect(transformed.slides[0]!.elements.at(-1)).toMatchObject({
      id: text!.id,
      x: 250,
      w: 600,
      rotation: 25,
      locked: true,
    });

    const removed = applyOps(transformed, [
      { op: "deleteElements", target: { by: "all" }, elementIds: [shape!.id] },
    ]).deck;
    expect(removed.slides[0]!.elements.map((el) => el.id)).toEqual([text!.id]);
  });

  it("edits content and styles, duplicates, aligns, and distributes by id", () => {
    const base = applyOps(deckOf(["A"]), [
      { op: "addTextBox", target: { by: "all" }, text: "one", x: 10, w: 100 },
      { op: "addTextBox", target: { by: "all" }, text: "two", x: 300, w: 100 },
      { op: "addTextBox", target: { by: "all" }, text: "three", x: 700, w: 100 },
    ]).deck;
    const ids = base.slides[0]!.elements.map((el) => el.id);
    const edited = applyOps(base, [
      { op: "setElementText", target: { by: "all" }, elementIds: [ids[0]!], text: "changed" },
      { op: "styleElements", target: { by: "all" }, elementIds: [ids[0]!], style: { color: "#ff0000", bold: true } },
      { op: "distributeElements", target: { by: "all" }, elementIds: ids, axis: "horizontal" },
      { op: "alignElements", target: { by: "all" }, elementIds: ids, align: "middle", relativeTo: "slide" },
      { op: "duplicateElements", target: { by: "all" }, elementIds: [ids[0]!], offsetX: 10, offsetY: 20 },
    ]).deck;
    const first = edited.slides[0]!.elements.find((el) => el.id === ids[0])!;
    const copy = edited.slides[0]!.elements.at(-1)!;
    expect(first).toMatchObject({ kind: "text", text: "changed", y: 280 });
    expect(first.kind === "text" && first.style).toMatchObject({ color: "#ff0000", bold: true });
    expect(edited.slides[0]!.elements[1]!.x).toBe(355);
    expect(copy).toMatchObject({ x: first.x + 10, y: first.y + 20, locked: false });
    expect(copy.id).not.toBe(first.id);
  });

  it("updates shape and image-specific properties", () => {
    const base = applyOps(deckOf(["A"]), [
      { op: "addShape", target: { by: "all" }, shape: "rect", fill: "#000000" },
      { op: "addImage", target: { by: "all" }, src: "assets/old.png" },
    ]).deck;
    const [shape, image] = base.slides[0]!.elements;
    const updated = applyOps(base, [
      { op: "updateShapes", target: { by: "all" }, elementIds: [shape!.id], shape: "ellipse", fill: null, stroke: "#ffffff", strokeWidth: 4 },
      { op: "updateImages", target: { by: "all" }, elementIds: [image!.id], src: "assets/new.png", fit: "cover", caption: "Cover" },
    ]).deck;
    expect(updated.slides[0]!.elements[0]).toMatchObject({ kind: "shape", shape: "ellipse", stroke: "#ffffff", strokeWidth: 4 });
    expect(updated.slides[0]!.elements[0]).not.toHaveProperty("fill");
    expect(updated.slides[0]!.elements[1]).toMatchObject({ kind: "image", src: "assets/new.png", fit: "cover", caption: "Cover" });
  });
});

describe("batching", () => {
  it("applies ops in order, each seeing the previous result", () => {
    // Create then immediately target what was created — this only works if
    // ops share one evolving deck rather than each seeing the original.
    const ops: Op[] = [
      { op: "createSlides", slides: [{ title: "Verse 1" }, { title: "Verse 2" }] },
      {
        op: "appendBody",
        target: { by: "nameOrdinal", base: "Verse", ordinals: [1, 2] },
        text: "C D E F",
      },
    ];
    const { deck } = applyOps(deckOf([]), ops);
    expect(roleText(deck.slides[0]!, "body")).toBe("C D E F");
    expect(roleText(deck.slides[1]!, "body")).toBe("C D E F");
  });

  it("does not mutate the input deck", () => {
    const original = deckOf(SONG);
    const snapshot = JSON.stringify(original);
    applyOps(original, [{ op: "deleteSlides", target: { by: "all" } }]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("validateOps", () => {
  it("accepts a batch that yields a valid deck", () => {
    const result = validateOps(deckOf([]), [
      { op: "createSlides", slides: [{ title: "Intro" }] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports a backwards cue instead of applying it", () => {
    // Deck.superRefine requires cues to run forward; a plausible instruction
    // can violate that, and the preview must catch it before the editor does.
    const deck = deckOf(["A", "B"]);
    const result = validateOps(deck, [
      { op: "setCue", target: { by: "index", indexes: [0] }, seconds: 90 },
      { op: "setCue", target: { by: "index", indexes: [1] }, seconds: 10 },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/forward/i);
  });
});
