import type { Deck } from "../../schema/deck.js";
import type { SongFacts } from "../genius.js";
import type { AgentResult } from "../ops.js";

/**
 * How a natural-language instruction becomes an op list.
 *
 * Every provider returns the *same* `AgentResult`, validated by the same Zod
 * schema, so preview / validation / apply / undo never learn which engine
 * answered. Adding a provider is one file plus one registry entry.
 */
export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  /** Shown in the panel so it's never a mystery which engine answered. */
  readonly description: string;
  /** False when this environment can't run it (no key, no Electron, no CLI). */
  available(): boolean;
  run(input: string, context: ProviderContext): Promise<AgentResult>;
}

export interface ProviderContext {
  deck: Deck;
  currentSlide: number;
  /**
   * Set on the second pass, after a lookup the model asked for. Carries the
   * outcome — the facts found, or an explanation that nothing was — so the
   * model can either use them or say plainly that it couldn't.
   */
  lookupOutcome?: { query: string; facts?: SongFacts; failure?: string };
  /**
   * Everything selected in the editor, so "align these" and "delete these"
   * mean what the user sees. An array because the canvas supports multi-select
   * and the ops have always taken `elementIds`.
   */
  selectedElementIds: string[];
  /**
   * Verified song metadata looked up before the provider ran, when the
   * instruction asked for it.
   *
   * Supplying real facts here prevents metadata requests from being answered
   * with placeholder-shaped text.
   */
  facts?: SongFacts;
}

/**
 * Providers in priority order. The deterministic parser is always first: it
 * is free, instant, offline, and needs no account, so an instruction it can
 * handle should never reach a language model. Later providers only see input
 * the earlier ones returned `unparsed` for.
 */
export function pickProviders(all: readonly AgentProvider[]): AgentProvider[] {
  return all.filter((p) => p.available());
}
