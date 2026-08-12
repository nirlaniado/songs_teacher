import { describe, expect, it } from "vitest";
import { Deck, DECK_SCHEMA_VERSION } from "../schema/deck.js";
import { parseCommand, parseTarget } from "./parse/grammar.js";
import { parseSectionRun, titlesFor, canonicalFor } from "./parse/sections.js";
import { resolveTarget } from "./targets.js";
import { applyOps } from "./apply.js";

const uuid = () => crypto.randomUUID();

function deckOf(names: string[]) {
  const now = new Date().toISOString();
  return Deck.parse({
    schemaVersion: DECK_SCHEMA_VERSION,
    id: uuid(),
    title: "Test",
    slides: names.map((name) => ({ id: uuid(), name })),
    createdAt: now,
    updatedAt: now,
  });
}

const empty = deckOf([]);

/** The structure the user asked for, verbatim. */
const SONG = ["Intro", "Verse 1", "Pre-Chorus", "Chorus 1", "Verse 2", "Bridge", "Chorus 2", "Verse 3"];

describe("section vocabulary", () => {
  it("reads a run of section words", () => {
    expect(parseSectionRun("intro verse chorus")).toEqual([
      { canonical: "Intro" },
      { canonical: "Verse" },
      { canonical: "Chorus" },
    ]);
  });

  it("attaches a number written against the word", () => {
    expect(parseSectionRun("verse1 verse2")).toEqual([
      { canonical: "Verse", number: 1 },
      { canonical: "Verse", number: 2 },
    ]);
  });

  it("prefers the longer alias so pre-hook is not read as hook", () => {
    expect(parseSectionRun("pre hook")).toEqual([{ canonical: "Pre-Chorus" }]);
    expect(parseSectionRun("prehook")).toEqual([{ canonical: "Pre-Chorus" }]);
  });

  it("treats hook as a chorus", () => {
    expect(parseSectionRun("hook")).toEqual([{ canonical: "Chorus" }]);
  });

  it("ignores filler words between sections", () => {
    expect(parseSectionRun("intro then chorus and outro")).toEqual([
      { canonical: "Intro" },
      { canonical: "Chorus" },
      { canonical: "Outro" },
    ]);
  });

  it("refuses a run containing a non-section word", () => {
    // Otherwise an unrelated sentence would be mistaken for a structure list.
    expect(parseSectionRun("intro banana chorus")).toBeNull();
    expect(parseSectionRun("some chords for later")).toBeNull();
  });

  it("does not match a section name inside a longer word", () => {
    expect(parseSectionRun("versatile")).toBeNull();
  });

  it("auto-numbers a repeated name but leaves a unique one bare", () => {
    expect(titlesFor(parseSectionRun("intro chorus verse chorus")!)).toEqual([
      "Intro",
      "Chorus 1",
      "Verse",
      "Chorus 2",
    ]);
  });

  it("honours explicit numbers over auto-numbering", () => {
    expect(titlesFor(parseSectionRun("verse1 chorus verse2")!)).toEqual([
      "Verse 1",
      "Chorus",
      "Verse 2",
    ]);
  });

  it("maps plurals to a family name", () => {
    expect(canonicalFor("verses")).toBe("Verse");
    expect(canonicalFor("choruses")).toBe("Chorus");
    expect(canonicalFor("bridge")).toBe("Bridge");
    expect(canonicalFor("banana")).toBeNull();
  });
});

describe("target parsing", () => {
  it("reads a family with ordinals", () => {
    expect(parseTarget("verses 1 2 3")).toEqual({
      by: "nameOrdinal",
      base: "Verse",
      ordinals: [1, 2, 3],
    });
  });

  it("reads a bare family as every slide in it", () => {
    expect(parseTarget("the choruses")).toEqual({ by: "family", base: "Chorus" });
  });

  it("reads explicit slide numbers as 0-based indexes", () => {
    expect(parseTarget("slide 3")).toEqual({ by: "index", indexes: [2] });
    expect(parseTarget("slides 2 and 4")).toEqual({ by: "index", indexes: [1, 3] });
  });

  it("reads a slide range", () => {
    expect(parseTarget("slides 2-4")).toEqual({ by: "index", indexes: [1, 2, 3] });
  });

  it("reads all and current", () => {
    expect(parseTarget("all slides")).toEqual({ by: "all" });
    expect(parseTarget("this slide")).toEqual({ by: "current" });
  });
});

describe("target resolution against a real deck", () => {
  const deck = deckOf(SONG);

  it("counts ordinals within the family, skipping other sections", () => {
    // Verses sit at 1, 4, 7 with a chorus and bridge between them.
    const target = parseTarget("verses 1 2 3")!;
    expect(resolveTarget(deck, target)).toEqual([1, 4, 7]);
  });

  it("does not let chorus match pre-chorus", () => {
    const target = parseTarget("choruses")!;
    expect(resolveTarget(deck, target)).toEqual([3, 6]);
  });

  it("drops out-of-range indexes instead of failing the batch", () => {
    expect(resolveTarget(deck, { by: "index", indexes: [0, 99] })).toEqual([0]);
  });

  it("returns nothing for a family that isn't in the deck", () => {
    expect(resolveTarget(deck, { by: "nameOrdinal", base: "Solo", ordinals: [1] })).toEqual([]);
  });
});

describe("parseCommand — the user's stated examples", () => {
  it("builds the whole song structure from one instruction", () => {
    const result = parseCommand(
      "create intro verse1 pre hook chorus verse2 bridge chorus verse3",
      empty,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
    const [op] = result.ops;
    expect(op!.op).toBe("createSlides");
    if (op!.op !== "createSlides") return;
    expect(op!.slides.map((s) => s.title)).toEqual(SONG);
  });

  it("adds chord text to exactly the three verses", () => {
    const deck = deckOf(SONG);
    const result = parseCommand("add chords C D E F to verses 1 2 3", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toEqual([
      {
        op: "appendBody",
        target: { by: "nameOrdinal", base: "Verse", ordinals: [1, 2, 3] },
        text: "C D E F",
      },
    ]);

    // End to end: only the verses change.
    const { deck: next } = applyOps(deck, result.ops);
    const bodies = next.slides.map(
      (s) =>
        s.elements.find(
          (el): el is Extract<typeof el, { kind: "text" }> =>
            el.kind === "text" && el.role === "body",
        )?.text ?? "",
    );
    expect(bodies[1]).toContain("C D E F");
    expect(bodies[4]).toContain("C D E F");
    expect(bodies[7]).toContain("C D E F");
    expect(bodies[3]).toBe(""); // Chorus 1 untouched
  });
});

describe("parseCommand — creating a slide with its text", () => {
  it("names the slide after the section and puts the spoken text in the title", () => {
    const result = parseCommand("create intro saying Until The End", empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [op] = result.ops;
    expect(op!.op).toBe("createSlides");
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]).toMatchObject({ name: "Intro", title: "Until The End" });
  });

  it("stacks a second line with 'under it'", () => {
    const result = parseCommand("create intro saying Until The End under it band: Some Band", empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]).toMatchObject({
      name: "Intro",
      title: "Until The End",
      body: "band: Some Band",
    });
  });

  it("places the text verbatim, without fixing spelling or case", () => {
    // The agent operates the app; it does not edit the user's words.
    const result = parseCommand("create intro saying untill the end", empty);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]!.title).toBe("untill the end");
  });

  it("keeps the head as a literal name when it isn't a known section", () => {
    const result = parseCommand("create a slide called Setlist saying Song one", empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]).toMatchObject({ name: "Setlist", title: "Song one" });
  });

  it("does not split on a bare 'under' inside ordinary text", () => {
    const result = parseCommand("create intro saying the bridge under construction", empty);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]!.title).toBe("the bridge under construction");
    expect(op!.slides[0]!.body).toBeUndefined();
  });

  it("still reads a bare section run as pure structure", () => {
    // The new rule must not swallow the original behaviour.
    const result = parseCommand("create intro verse1 chorus", empty);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides.map((s) => s.title)).toEqual(["Intro", "Verse 1", "Chorus"]);
  });

  it("the created slide is targetable by its section name afterwards", () => {
    const made = parseCommand("create intro saying Until The End", empty);
    if (!made.ok) return;
    const { deck } = applyOps(empty, made.ops);
    const next = parseCommand("add chords C D to the intro", deck);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const { deck: after } = applyOps(deck, next.ops);
    const body = after.slides[0]!.elements.find(
      (el): el is Extract<typeof el, { kind: "text" }> => el.kind === "text" && el.role === "body",
    );
    expect(body?.text).toContain("C D");
  });
});

describe("parseCommand — other supported shapes", () => {
  const deck = deckOf(SONG);

  it("sets a cue time, reusing the schema's own time parser", () => {
    const result = parseCommand("cue the chorus at 2:22", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toEqual({
      op: "setCue",
      target: { by: "family", base: "Chorus" },
      seconds: 142,
    });
  });

  it("reports an unreadable time rather than guessing", () => {
    const result = parseCommand("cue the chorus at half past", deck);
    expect(result.ok).toBe(false);
  });

  it("clears a cue", () => {
    const result = parseCommand("clear the cue from the bridge", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]!.op).toBe("clearCue");
  });

  it("applies a layout by its human label", () => {
    const result = parseCommand("make the intro a centered title", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toMatchObject({ op: "setLayout", layout: "centered" });
  });

  it("renames a slide", () => {
    const result = parseCommand("rename slide 1 to Opening", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toEqual({
      op: "renameSlide",
      target: { by: "index", indexes: [0] },
      name: "Opening",
    });
  });

  it("treats 'set' as replacing text and 'add' as appending", () => {
    const setResult = parseCommand("set lyrics Hello to slide 1", deck);
    const addResult = parseCommand("add lyrics Hello to slide 1", deck);
    expect(setResult.ok && setResult.ops[0]!.op).toBe("setBody");
    expect(addResult.ok && addResult.ops[0]!.op).toBe("appendBody");
  });

  it("strips a content noise word so the payload is just the text", () => {
    const result = parseCommand("add chords: G Am F C to the bridge", deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toMatchObject({ text: "G Am F C" });
  });

  it("prefers content over structure for 'add X to Y'", () => {
    // "add ... to ..." must not be read as "create sections".
    const result = parseCommand("add chords C to the chorus", deck);
    expect(result.ok && result.ops[0]!.op).toBe("appendBody");
  });
});

describe("parseCommand — pasted [Section] blocks", () => {
  // Placeholder text throughout: the feature distributes whatever the user
  // pastes, so the tests only care about routing, never about content.
  const PASTE = ["[Intro]", "line one", "line two", "", "[Chorus]", "hook line"].join("\n");

  it("creates a slide per block, in the order pasted", () => {
    const result = parseCommand(PASTE, empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(2);
    const { deck } = applyOps(empty, result.ops);
    expect(deck.slides.map((s) => s.name)).toEqual(["Intro", "Chorus"]);
  });

  it("puts each block's text on its own slide", () => {
    const result = parseCommand(PASTE, empty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { deck } = applyOps(empty, result.ops);
    const bodyOf = (i: number) =>
      deck.slides[i]!.elements.find(
        (el): el is Extract<typeof el, { kind: "text" }> =>
          el.kind === "text" && el.role === "body",
      )?.text;
    expect(bodyOf(0)).toBe("line one\nline two");
    expect(bodyOf(1)).toBe("hook line");
  });

  it("fills an existing slide instead of duplicating it", () => {
    const deck = deckOf(["Intro", "Chorus"]);
    const result = parseCommand(PASTE, deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops.every((o) => o.op === "setBody")).toBe(true);
    const { deck: next } = applyOps(deck, result.ops);
    expect(next.slides).toHaveLength(2);
  });

  it("mixes filling and creating when only some slides exist", () => {
    const deck = deckOf(["Intro"]);
    const result = parseCommand(PASTE, deck);
    if (!result.ok) return;
    expect(result.ops.map((o) => o.op)).toEqual(["setBody", "createSlides"]);
  });

  it("ignores a title line before the first header", () => {
    const result = parseCommand(`Some Song Title\n\n[Intro]\nwords`, empty);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
  });

  it("keeps an unrecognised tag as its own slide name", () => {
    const result = parseCommand("[Guitar Tab]\nsome notation", empty);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides[0]!.title).toBe("Guitar Tab");
  });

  it("creates a slide for a header with no text under it", () => {
    const result = parseCommand("[Bridge]", empty);
    if (!result.ok) return;
    const { deck } = applyOps(empty, result.ops);
    expect(deck.slides.map((s) => s.name)).toEqual(["Bridge"]);
  });

  it("leaves ordinary one-line commands to the normal rules", () => {
    // No headers present, so this must not be treated as pasted content.
    const result = parseCommand("create intro verse1 chorus", empty);
    if (!result.ok) return;
    const [op] = result.ops;
    if (op!.op !== "createSlides") return;
    expect(op!.slides).toHaveLength(3);
  });
});

describe("parseCommand — failure modes", () => {
  it("rejects empty input", () => {
    expect(parseCommand("   ", empty).ok).toBe(false);
  });

  it("returns a helpful message for gibberish, changing nothing", () => {
    const result = parseCommand("asdfgh qwerty", empty);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("didn't understand");
  });
});

describe("parseCommand — element commands", () => {
  const selected = crypto.randomUUID();

  it("turns common selected-element actions into stable-id operations", () => {
    const rotate = parseCommand("rotate this by 15 degrees", deckOf(["A"]), [selected]);
    const lock = parseCommand("lock selected element", deckOf(["A"]), [selected]);
    const order = parseCommand("bring this to the front", deckOf(["A"]), [selected]);
    const duplicate = parseCommand("duplicate selected element", deckOf(["A"]), [selected]);
    const remove = parseCommand("delete this element", deckOf(["A"]), [selected]);

    expect(rotate.ok && rotate.ops[0]).toMatchObject({ op: "updateElements", elementIds: [selected], rotation: 15 });
    expect(lock.ok && lock.ops[0]).toMatchObject({ op: "updateElements", elementIds: [selected], locked: true });
    expect(order.ok && order.ops[0]).toMatchObject({ op: "reorderElement", elementId: selected, direction: "front" });
    expect(duplicate.ok && duplicate.ops[0]).toMatchObject({ op: "duplicateElements", elementIds: [selected] });
    expect(remove.ok && remove.ops[0]).toMatchObject({ op: "deleteElements", elementIds: [selected] });
  });

  it("aligns a multi-selection to itself and a lone element to the slide", () => {
    // The rule Impress uses, and the reason "centre it" on one shape isn't a
    // no-op: with nothing else selected, the page is what it aligns within.
    const pair = [selected, crypto.randomUUID()];
    const group = parseCommand("align these left", deckOf(["A"]), pair);
    const lone = parseCommand("align the selected element to the centre", deckOf(["A"]), [selected]);

    expect(group.ok && group.ops[0]).toMatchObject({
      op: "alignElements",
      elementIds: pair,
      align: "left",
      relativeTo: "selection",
    });
    expect(lone.ok && lone.ops[0]).toMatchObject({
      op: "alignElements",
      align: "center",
      relativeTo: "slide",
    });
  });

  it("distributes three or more and explains the refusal below that", () => {
    const three = [selected, crypto.randomUUID(), crypto.randomUUID()];
    const ok = parseCommand("distribute these horizontally", deckOf(["A"]), three);
    expect(ok.ok && ok.ops[0]).toMatchObject({ op: "distributeElements", axis: "horizontal" });

    const tooFew = parseCommand("distribute these vertically", deckOf(["A"]), three.slice(0, 2));
    expect(tooFew.ok).toBe(false);
    if (tooFew.ok) return;
    expect(tooFew.message).toMatch(/at least three/i);
  });

  it("keeps a multi-selection's stacking when arranging it", () => {
    // One reorderElement op per element, ordered so the block doesn't invert.
    const pair = [selected, crypto.randomUUID()];
    const result = parseCommand("send these to the back", deckOf(["A"]), pair);
    expect(result.ok && result.ops).toHaveLength(2);
    expect(result.ok && result.ops[0]).toMatchObject({ elementId: pair[1], direction: "back" });
  });

  it("asks for a selection instead of deleting a slide named selected", () => {
    const result = parseCommand("delete selected element", deckOf(["Selected"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/select an element/i);
  });

  it("creates a named-colour shape on a parsed slide target", () => {
    const result = parseCommand("add red circle to slide 2", deckOf(["A", "B"]));
    expect(result.ok && result.ops[0]).toMatchObject({
      op: "addShape",
      target: { by: "index", indexes: [1] },
      shape: "ellipse",
      fill: "#ef4444",
    });
  });
});
