import { create, type StoreApi } from "zustand";
import { validateOps } from "../agent/apply.js";
import { describeOps } from "../agent/describe.js";
import {
  MIN_CONFIDENCE,
  searchSongs,
  withAlbum,
  type SongCandidate,
  type SongFacts,
} from "../agent/genius.js";
import { resolveSongFacts } from "../agent/lookup.js";
import type { Op } from "../agent/ops.js";
import { availableProviders, hasModelProvider } from "../agent/providers/index.js";
import { useDeckStore } from "./deckStore.js";

/**
 * Conversation state for the agent panel.
 *
 * Nothing here mutates the deck. An instruction produces a *pending plan* —
 * ops plus their human descriptions plus any validation error — and the deck
 * only changes when the user presses Apply. That split is the entire safety
 * story: a misread instruction costs a glance, not an undo.
 */

export interface PlanLine {
  text: string;
  destructive: boolean;
  /** True when the op resolves to zero slides, so the preview can warn. */
  empty: boolean;
}

export interface PendingPlan {
  instruction: string;
  ops: Op[];
  lines: PlanLine[];
  /** Set when applying would produce an invalid deck; blocks Apply. */
  error: string | null;
  /** Which engine produced this, so behaviour is never mysterious. */
  providerLabel: string;
  /**
   * The exact editor state this preview describes. Kept by reference rather
   * than serialized: deckStore mutations are immutable, so a different
   * object means the user edited, undid, redid, or opened a deck meanwhile.
   */
  previewedDeck: NonNullable<ReturnType<typeof useDeckStore.getState>["deck"]>;
  previewedCurrentSlide: number;
  /** Compared by reference: the store replaces the array on every change. */
  previewedSelection: readonly string[];
  /** Explains why Apply paused and refreshed instead of changing the deck. */
  notice: string | null;
}

export interface TranscriptEntry {
  instruction: string;
  outcome: string;
  ok: boolean;
}

/**
 * A song search the user has to settle, because Genius returned nothing the
 * scorer would accept.
 *
 * Asking beats both alternatives: taking the top hit is what put a stranger's
 * music-collection page onto a title slide, and giving up discards results
 * that are often correct under a different spelling.
 */
export interface PendingLookup {
  /** The instruction to resume once a choice is made. */
  instruction: string;
  /** What the model searched for — shown so a bad query is visible, not silent. */
  query: string;
  /** The model's own words on why it searched. */
  reason?: string;
  candidates: SongCandidate[];
}

interface AgentState {
  open: boolean;
  running: boolean;
  pending: PendingPlan | null;
  /** Set when no provider could interpret the instruction. */
  message: string | null;
  /** Set when a song search needs the user to pick, or confirm nothing fits. */
  lookupChoice: PendingLookup | null;
  transcript: TranscriptEntry[];

  toggle(): void;
  submit(instruction: string): Promise<void>;
  /** Resumes a paused instruction with the song the user picked. */
  chooseSong(candidate: SongCandidate): Promise<void>;
  /** Resumes with "nothing matched", so the model says so instead of guessing. */
  rejectCandidates(): Promise<void>;
  applyPending(): void;
  discardPending(): void;
}

/** The lookup result handed back to a provider on its second pass. */
type LookupOutcome = { query: string; facts?: SongFacts; failure?: string };

export const useAgentStore = create<AgentState>((set, get) => ({
  open: false,
  running: false,
  pending: null,
  message: null,
  lookupChoice: null,
  transcript: [],

  toggle() {
    set({ open: !get().open });
  },

  async submit(instruction) {
    set({ running: true, message: null, pending: null, lookupChoice: null });

    // Who works out what the user meant depends on what's available. A model
    // reads phrasing, typos and compound sentences correctly and asks for a
    // lookup itself; the regexes in `lookup.ts` only approximate that, and
    // needed patching for every new phrasing. They remain the fallback for an
    // offline, parser-only setup rather than the default path.
    let facts: SongFacts | undefined;
    if (!hasModelProvider()) {
      const lookup = await resolveSongFacts(instruction);
      if (lookup.answer) {
        set({
          running: false,
          pending: null,
          message: null,
          transcript: [...get().transcript, { instruction, outcome: lookup.answer, ok: true }],
        });
        return;
      }
      if (lookup.blocked) {
        set({
          running: false,
          message: lookup.blocked,
          transcript: [...get().transcript, { instruction, outcome: lookup.blocked, ok: false }],
        });
        return;
      }
      facts = lookup.facts;
    }

    await runPipeline(set, get, instruction, facts, undefined);
  },

  async chooseSong(candidate) {
    const paused = get().lookupChoice;
    if (!paused) return;
    set({ running: true, lookupChoice: null, message: null });
    const facts = await withAlbum(candidate);
    await runPipeline(set, get, paused.instruction, undefined, {
      query: paused.query,
      facts,
    });
  },

  async rejectCandidates() {
    const paused = get().lookupChoice;
    if (!paused) return;
    set({ running: true, lookupChoice: null, message: null });
    await runPipeline(set, get, paused.instruction, undefined, {
      query: paused.query,
      failure: "The user reviewed the search results and said none of them is the right song.",
    });
  },

  applyPending() {
    const plan = get().pending;
    if (!plan || plan.error) return;
    const deckState = useDeckStore.getState();
    const { deck, currentSlide, selectedElementIds } = deckState;
    if (!deck) return;

    // A preview is only trustworthy for the state it described. Model calls
    // are asynchronous and the editor remains usable while a plan is pending,
    // so both the deck and the meaning of {by:"current"} can change before
    // Apply is pressed. Refresh and stop here: applying immediately would deny
    // the user a chance to review the newly resolved slide names.
    if (
      deck !== plan.previewedDeck ||
      currentSlide !== plan.previewedCurrentSlide ||
      selectedElementIds !== plan.previewedSelection
    ) {
      const validated = validateOps(deck, plan.ops, currentSlide);
      set({
        pending: {
          ...plan,
          lines: describeOps(deck, plan.ops, currentSlide),
          error: validated.ok ? null : validated.error,
          previewedDeck: deck,
          previewedCurrentSlide: currentSlide,
          previewedSelection: selectedElementIds,
          notice: "The deck changed, so this preview was refreshed. Review it, then apply again.",
        },
      });
      return;
    }

    deckState.applyAgentOps(plan.ops);
    set({
      pending: null,
      message: null,
      transcript: [
        ...get().transcript,
        {
          instruction: plan.instruction,
          outcome: `Applied ${plan.ops.length} change${plan.ops.length === 1 ? "" : "s"} — Ctrl+Z to undo`,
          ok: true,
        },
      ],
    });
  },

  discardPending() {
    set({ pending: null, message: null, lookupChoice: null });
  },
}));

type Set = StoreApi<AgentState>["setState"];
type Get = StoreApi<AgentState>["getState"];

/**
 * Runs the instruction through the providers and turns whatever comes back
 * into store state.
 *
 * Extracted from `submit` because it is entered twice: once for the original
 * instruction, and again after a lookup, carrying its outcome. Re-entering
 * from the top rather than resuming one provider keeps this a plain function
 * of (instruction, outcome) — and costs nothing, because a provider that
 * declined the first pass declines the second identically.
 */
async function runPipeline(
  set: Set,
  get: Get,
  instruction: string,
  facts: SongFacts | undefined,
  lookupOutcome: LookupOutcome | undefined,
): Promise<void> {
  const { deck, currentSlide, selectedElementIds } = useDeckStore.getState();
  if (!deck) {
    set({ running: false });
    return;
  }

  // Providers in priority order; the first that understands wins. The
  // deterministic parser is first, so anything it handles never reaches a
  // language model — free and instant by default.
  let lastMessage = "I didn't understand that.";
  for (const provider of availableProviders()) {
    let result;
    try {
      result = await provider.run(instruction, {
        deck,
        currentSlide,
        selectedElementIds,
        ...(facts ? { facts } : {}),
        ...(lookupOutcome ? { lookupOutcome } : {}),
      });
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      continue;
    }

    // The provider understood the request but wants a song looked up first.
    // Stop the loop: falling through to a later provider would answer a
    // question this one is mid-way through asking.
    if (!result.ok && result.reason === "needs-lookup") {
      await resolveLookup(set, get, instruction, result.query, result.message);
      return;
    }

    if (!result.ok) {
      lastMessage = result.message;
      continue;
    }

    // Providers may answer conversationally without proposing mutations.
    // This is a successful assistant response, not a failed edit plan.
    if (result.ops.length === 0 && result.message) {
      set({
        running: false,
        pending: null,
        message: null,
        transcript: [...get().transcript, { instruction, outcome: result.message, ok: true }],
      });
      return;
    }

    const validated = validateOps(deck, result.ops, currentSlide);
    // Folds the deck forward between ops, so "create Verse 1, then add
    // chords to Verse 1" describes the second line against the slide the
    // first line creates — rather than reporting "matches nothing".
    const lines: PlanLine[] = describeOps(deck, result.ops, currentSlide);

    set({
      running: false,
      transcript: result.message
        ? [...get().transcript, { instruction, outcome: result.message, ok: true }]
        : get().transcript,
      pending: {
        instruction,
        ops: result.ops,
        lines,
        error: validated.ok ? null : validated.error,
        providerLabel: provider.label,
        previewedDeck: deck,
        previewedCurrentSlide: currentSlide,
        previewedSelection: selectedElementIds,
        notice: null,
      },
    });
    return;
  }

  set({
    running: false,
    message: lastMessage,
    transcript: [...get().transcript, { instruction, outcome: lastMessage, ok: false }],
  });
}

/**
 * Answers a lookup the provider asked for, then resumes.
 *
 * Three outcomes, and the distinction between them is the whole point:
 *
 *  - **Confident match** — resume with the facts, no interruption.
 *  - **Only weak matches** — pause and ask. Genius indexes user collection
 *    pages as songs, so an unchecked best-hit is how "KamZ's Music Collection"
 *    reached a title slide; a wrong-but-plausible answer is worse than a
 *    question.
 *  - **Nothing at all** — resume with the failure, so the model reports it in
 *    its own words rather than inventing the details.
 */
async function resolveLookup(
  set: Set,
  get: Get,
  instruction: string,
  query: string,
  reason: string,
): Promise<void> {
  let candidates: SongCandidate[];
  try {
    candidates = await searchSongs(query);
  } catch (err) {
    await runPipeline(set, get, instruction, undefined, {
      query,
      failure: `The search itself failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const best = candidates[0];
  if (best && best.confidence >= MIN_CONFIDENCE) {
    await runPipeline(set, get, instruction, undefined, {
      query,
      facts: await withAlbum(best),
    });
    return;
  }

  if (candidates.length > 0) {
    set({
      running: false,
      lookupChoice: { instruction, query, ...(reason ? { reason } : {}), candidates },
    });
    return;
  }

  await runPipeline(set, get, instruction, undefined, {
    query,
    failure: `Genius returned no match for "${query}".`,
  });
}
