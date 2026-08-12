import { describe, expect, it } from "vitest";
import { newDeck, TabElement } from "../schema/deck.js";
import { applyOps } from "./apply.js";
import { describeDeck, opListJsonSchema, systemPrompt } from "./prompt.js";

describe("describeDeck", () => {
  it("exposes existing text, element ids, geometry, and locking to model providers", () => {
    const deck = applyOps(newDeck({ id: crypto.randomUUID(), title: "Test" }), [
      { op: "createSlides", slides: [{ title: "Intro", body: "Existing body text" }] },
    ]).deck;
    const description = describeDeck(deck, 0, [deck.slides[0]!.elements[0]!.id]);
    const body = deck.slides[0]!.elements.find(
      (el) => el.kind === "text" && el.role === "body",
    )!;

    expect(description).toContain("Existing body text");
    expect(description).toContain(body.id);
    expect(description).toContain(`x=${body.x},y=${body.y},w=${body.w},h=${body.h}`);
    expect(description).toContain("locked=false");
    expect(description).toContain("CURRENT");
    expect(description).toContain("SELECTED");
    expect(description).toContain("style=");
  });

  it("labels a tab element as a tab, not the shape fallback", () => {
    // The kind-branch in describeDeck was an if/if/fallback, not an exhaustive
    // switch — adding "tab" without a branch would have silently mislabeled
    // every one as a shape and confused the model about what it can do to it.
    let deck = applyOps(newDeck({ id: crypto.randomUUID(), title: "Test" }), [
      { op: "createSlides", slides: [{ title: "Intro" }] },
    ]).deck;
    const tab = TabElement.parse({
      id: crypto.randomUUID(),
      kind: "tab",
      x: 10,
      y: 10,
      w: 400,
      h: 160,
      text: "e|--0--|",
    });
    deck = { ...deck, slides: [{ ...deck.slides[0]!, elements: [...deck.slides[0]!.elements, tab] }] };

    const description = describeDeck(deck, 0);
    expect(description).toContain(`tab id=${tab.id}`);
    expect(description).toContain("e|--0--|");
    expect(description).not.toContain(`shape id=${tab.id}`);
  });
});

describe("assistant response contract", () => {
  it("allows conversational answers when no deck edits are needed", () => {
    expect(JSON.stringify(opListJsonSchema())).toContain("message");
    expect(systemPrompt(newDeck({ id: crypto.randomUUID(), title: "Test" }))).toContain(
      '"message":"your answer"',
    );
  });

  it("offers a lookup request as a valid reply, so the model can ask instead of guess", () => {
    // The schema is what a constrained endpoint enforces. If `lookup` isn't in
    // it, the model is structurally unable to ask and falls back to inventing.
    const schema = JSON.stringify(opListJsonSchema());
    expect(schema).toContain("lookup");
    expect(schema).toContain("query");
    expect(systemPrompt(newDeck({ id: crypto.randomUUID(), title: "Test" }))).toContain(
      "LOOKING SONGS UP",
    );
  });
});

describe("lookup outcome in the prompt", () => {
  const deck = () => newDeck({ id: crypto.randomUUID(), title: "Test" });

  it("hands back the facts when the search succeeded", () => {
    const prompt = systemPrompt(deck(), undefined, 0, [], {
      query: "untill the end avanged sevenfokd",
      facts: {
        title: "Unholy Confessions",
        artist: "Avenged Sevenfold",
        year: "2003",
        url: "https://genius.com/x",
      },
    });
    expect(prompt).toContain("LOOKUP RESULT");
    expect(prompt).toContain("Unholy Confessions");
    expect(prompt).toContain("Avenged Sevenfold");
  });

  it("states the failure plainly and forbids inventing the details", () => {
    // The exact behaviour the user asked for: knowing what to do when Genius
    // hasn't found the right song.
    const prompt = systemPrompt(deck(), undefined, 0, [], {
      query: "some song nobody indexed",
      failure: "Genius returned no match.",
    });
    expect(prompt).toContain("NOT FOUND");
    expect(prompt).toContain("do not invent");
    expect(prompt).toContain('{"ops":[]}');
  });

  it("tells the model not to ask twice once a lookup has been answered", () => {
    const prompt = systemPrompt(deck(), undefined, 0, [], {
      query: "anything",
      failure: "no match",
    });
    expect(prompt).toContain("Do not ask again");
  });
});
