import { codexCliProvider } from "./codexCli.js";
import { deterministicProvider } from "./deterministic.js";
import { openAiCompatibleProvider } from "./openaiCompatible.js";
import type { AgentProvider } from "./types.js";

export * from "./types.js";
export { deterministicProvider } from "./deterministic.js";
export { codexCliProvider } from "./codexCli.js";
export {
  openAiCompatibleProvider,
  loadLlmConfig,
  envLlmConfig,
  saveLlmConfig,
  testLlmConfig,
  LLM_PRESETS,
  type LlmConfig,
} from "./openaiCompatible.js";

/**
 * Providers in the order they're tried. The deterministic parser is first
 * because it is free, instant and offline — anything it understands should
 * never reach a language model. Later providers only see input the earlier
 * ones returned `unparsed` for.
 */
export const PROVIDERS: readonly AgentProvider[] = [
  deterministicProvider,
  codexCliProvider,
  openAiCompatibleProvider,
];

/**
 * Providers this environment can actually run.
 *
 * A plain module function, deliberately not a store field: it builds a new
 * array per call, and anything that returns a fresh array must never be read
 * through a Zustand selector — `Object.is` would see a change every render
 * and spin until React bails out. Availability is environment state, not
 * store state, so it has no business living in a store.
 */
export function availableProviders(): AgentProvider[] {
  return PROVIDERS.filter((p) => p.available());
}

/**
 * Whether a language model can be reached.
 *
 * The caller uses this to decide who works out what the user meant. With a
 * model present, the model does it — including asking for a song lookup when
 * it needs one. Without one, the regex intent-detection in `lookup.ts` is the
 * only thing that can, so it stays as the fallback rather than being deleted.
 */
export function hasModelProvider(): boolean {
  return availableProviders().some((p) => p.id !== deterministicProvider.id);
}
