import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOps } from "../agent/apply.js";
import { describeOps } from "../agent/describe.js";
import type { Op } from "../agent/ops.js";
import { saveLlmConfig } from "../agent/providers/index.js";
import { newDeck } from "../schema/deck.js";
import { useAgentStore } from "./agentStore.js";
import { useDeckStore } from "./deckStore.js";

function titleOf(index: number): string {
  const slide = useDeckStore.getState().deck!.slides[index]!;
  const title = slide.elements.find((el) => el.kind === "text" && el.role === "title");
  return title?.kind === "text" ? title.text : "";
}

describe("stale agent plans", () => {
  it("refreshes a current-slide preview and requires confirmation again", () => {
    const original = applyOps(newDeck({ id: crypto.randomUUID(), title: "Test" }), [
      { op: "createSlides", slides: [{ title: "Intro" }, { title: "Chorus" }] },
    ]).deck;
    const ops: Op[] = [
      { op: "setTitle", target: { by: "current" }, text: "Changed" },
    ];

    useDeckStore.setState({ deck: original, currentSlide: 0, past: [], future: [] });
    useAgentStore.setState({
      pending: {
        instruction: "change this title",
        ops,
        lines: describeOps(original, ops, 0),
        error: null,
        providerLabel: "Test",
        previewedDeck: original,
        previewedCurrentSlide: 0,
        previewedSelection: [],
        notice: null,
      },
      transcript: [],
      message: null,
    });

    // Moving the selection changes the meaning of {by:"current"}. The first
    // Apply must only refresh the preview, not edit the newly selected slide.
    useDeckStore.setState({ currentSlide: 1 });
    useAgentStore.getState().applyPending();

    expect(titleOf(0)).toBe("Intro");
    expect(titleOf(1)).toBe("Chorus");
    expect(useAgentStore.getState().pending?.lines[0]?.text).toContain("Chorus");
    expect(useAgentStore.getState().pending?.notice).toMatch(/refreshed/i);

    // The refreshed preview now describes the live state, so a second Apply
    // performs the operation against exactly what the user just reviewed.
    useAgentStore.getState().applyPending();
    expect(titleOf(0)).toBe("Intro");
    expect(titleOf(1)).toBe("Changed");
    expect(useAgentStore.getState().pending).toBeNull();
  });
});

/**
 * What happens when Genius doesn't confidently find the song.
 *
 * The assistant used to either write a wrong result onto a slide or fail with
 * an unrelated message. Now the model asks, the store searches, and the three
 * outcomes are distinct: use it, ask the user, or say plainly it wasn't found.
 */
describe("song lookup round trip", () => {
  /** Model replies, in order, one per `/chat/completions` call. */
  let modelReplies: unknown[];
  /** Genius search hits for the next `/api/genius/search` call. */
  let geniusHits: Array<{ id: number; title: string; artist: string }>;

  beforeEach(() => {
    modelReplies = [];
    geniusHits = [];

    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    saveLlmConfig({ baseUrl: "http://localhost/v1", apiKey: "k", model: "test" });

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/chat/completions")) {
        const next = modelReplies.shift() ?? { ops: [], message: "unexpected extra call" };
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(next) } }] }),
        };
      }
      if (String(url).includes("/api/genius/search")) {
        return {
          ok: true,
          json: async () => ({
            response: {
              hits: geniusHits.map((h) => ({
                type: "song",
                result: {
                  id: h.id,
                  title: h.title,
                  primary_artist: { name: h.artist },
                  url: `https://genius.com/${h.id}`,
                },
              })),
            },
          }),
        };
      }
      // The album lookup for a chosen candidate; absent is a valid answer.
      return { ok: false, status: 404 };
    });

    useDeckStore.setState({
      deck: newDeck({ id: crypto.randomUUID(), title: "Test" }),
      currentSlide: 0,
      past: [],
      future: [],
    });
    useAgentStore.setState({ pending: null, message: null, lookupChoice: null, transcript: [] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses a confident match without interrupting the user", async () => {
    geniusHits = [{ id: 2, title: "Unholy Confessions", artist: "Avenged Sevenfold" }];
    modelReplies = [
      { lookup: { query: "unholy confessions avanged sevenfold" } },
      { ops: [{ op: "createSlides", slides: [{ title: "Unholy Confessions" }] }] },
    ];

    await useAgentStore
      .getState()
      .submit("ad the metadata for unholy confessions avanged sevenfold to a new first slide");

    const state = useAgentStore.getState();
    expect(state.lookupChoice).toBeNull();
    expect(state.pending?.ops).toHaveLength(1);
  });

  it("asks which song when nothing scores well enough to trust", async () => {
    // The failure the user hit: Genius returns something, but not the song.
    // Guessing here is what put a stranger's collection page on a slide.
    geniusHits = [{ id: 9, title: "Confessions", artist: "Another Artist" }];
    modelReplies = [{ lookup: { query: "unholy confessions avanged sevenfold" } }];

    await useAgentStore.getState().submit("metadata for unholy confessions avanged sevenfold");

    const state = useAgentStore.getState();
    expect(state.running).toBe(false);
    expect(state.pending).toBeNull();
    expect(state.lookupChoice?.candidates.map((c) => c.title)).toEqual(["Confessions"]);
  });

  it("resumes with the song the user picks", async () => {
    geniusHits = [{ id: 9, title: "Confessions", artist: "Another Artist" }];
    modelReplies = [{ lookup: { query: "unholy confessions avanged sevenfold" } }];
    await useAgentStore.getState().submit("metadata for unholy confessions avanged sevenfold");

    const choice = useAgentStore.getState().lookupChoice!.candidates[0]!;
    modelReplies = [{ ops: [{ op: "createSlides", slides: [{ title: "Confessions" }] }] }];
    await useAgentStore.getState().chooseSong(choice);

    const state = useAgentStore.getState();
    expect(state.lookupChoice).toBeNull();
    expect(state.pending?.ops).toHaveLength(1);
  });

  it("tells the model the search failed rather than letting it invent details", async () => {
    geniusHits = [];
    modelReplies = [
      { lookup: { query: "a song nobody indexed" } },
      { ops: [], message: "I couldn't find that song on Genius." },
    ];

    await useAgentStore.getState().submit("metadata for a song nobody indexed");

    const state = useAgentStore.getState();
    expect(state.pending).toBeNull();
    expect(state.lookupChoice).toBeNull();
    // A plain answer in the transcript, not an edit plan built from guesses.
    expect(state.transcript.at(-1)).toMatchObject({
      ok: true,
      outcome: "I couldn't find that song on Genius.",
    });
  });

  it("reports a search that errored instead of silently producing nothing", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/chat/completions")) {
        const next = modelReplies.shift();
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(next) } }] }),
        };
      }
      return { ok: false, status: 401 };
    });

    modelReplies = [
      { lookup: { query: "anything" } },
      { ops: [], message: "The song search isn't working — check the Genius token." },
    ];

    await useAgentStore.getState().submit("metadata for anything");
    expect(useAgentStore.getState().transcript.at(-1)?.outcome).toContain("Genius token");
  });
});
