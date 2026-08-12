import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newDeck } from "../../schema/deck.js";
import { openAiCompatibleProvider, saveLlmConfig } from "./openaiCompatible.js";
import type { ProviderContext } from "./types.js";

/**
 * The lookup round trip, which is what stopped the assistant inventing song
 * details it had no way to know.
 *
 * The model asking is the whole design: regex intent-detection had to be
 * patched for every new phrasing, and still misread typos, compound sentences
 * and destination clauses.
 */

/** localStorage stand-in — these tests run in Node, with no DOM. */
function stubStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

/** A chat-completions response carrying `content` as the model's reply. */
function reply(content: unknown) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  };
}

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    deck: newDeck({ id: crypto.randomUUID(), title: "Test" }),
    currentSlide: 0,
    selectedElementIds: [],
    ...overrides,
  };
}

describe("openAiCompatibleProvider lookup contract", () => {
  beforeEach(() => {
    stubStorage();
    saveLlmConfig({ baseUrl: "http://localhost/v1", apiKey: "k", model: "test" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces a lookup request instead of treating it as a failed plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({ lookup: { query: "untill the end avanged sevenfokd", reason: "need real facts" } }),
      ),
    );

    const result = await openAiCompatibleProvider.run(
      "find the metadata for avanged sevenfokd untill the end and make a first slide",
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("needs-lookup");
    if (result.reason !== "needs-lookup") return;
    expect(result.query).toBe("untill the end avanged sevenfokd");
    expect(result.message).toBe("need real facts");
  });

  it("passes the lookup outcome to the model on the second pass", async () => {
    let sent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent = init.body;
        return reply({ ops: [], message: "I couldn't find that song." });
      }),
    );

    const result = await openAiCompatibleProvider.run(
      "find the metadata for a song nobody indexed",
      context({ lookupOutcome: { query: "a song nobody indexed", failure: "no match" } }),
    );

    const body = JSON.parse(sent) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toContain("NOT FOUND");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toEqual([]);
    expect(result.message).toBe("I couldn't find that song.");
  });

  it("ignores a second lookup request, so a model can't search in a loop", async () => {
    // One round trip is the contract. A model that dislikes the result would
    // otherwise keep asking, and every attempt costs the user a request.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ lookup: { query: "try again" }, message: "still unsure" })),
    );

    const result = await openAiCompatibleProvider.run(
      "find that song",
      context({ lookupOutcome: { query: "first attempt", failure: "no match" } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("still unsure");
  });

  it("still accepts a plain op list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({ ops: [{ op: "createSlides", slides: [{ title: "Intro" }] }] }),
      ),
    );

    const result = await openAiCompatibleProvider.run("create an intro slide", context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
  });
});
