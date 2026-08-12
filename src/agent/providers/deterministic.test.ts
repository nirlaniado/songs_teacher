import { describe, expect, it } from "vitest";
import { newDeck } from "../../schema/deck.js";
import { deterministicProvider } from "./deterministic.js";

describe("metadata edit routing", () => {
  it("creates a new first slide when the instruction explicitly asks for one", async () => {
    const deck = newDeck({ id: crypto.randomUUID(), title: "Test" });
    const result = await deterministicProvider.run(
      'find metadata for Avenged Sevenfold "Until the End" and create a new first slide with it',
      {
        deck,
        currentSlide: 0,
        selectedElementIds: [],
        facts: {
          title: "Until the End",
          artist: "Avenged Sevenfold",
          album: "Diamonds in the Rough",
          year: "2008",
          url: "https://genius.com/example",
        },
      },
    );

    expect(result.ok && result.ops[0]).toMatchObject({
      op: "createSlides",
      at: 0,
      slides: [
        {
          title: "Until the End",
          name: "Until the End",
          body: "Avenged Sevenfold · Diamonds in the Rough · 2008",
          layout: "centered",
        },
      ],
    });
  });
});
