import { factsSummary } from "../genius.js";
import { parseCommand, parseTarget } from "../parse/grammar.js";
import type { Op } from "../ops.js";
import type { AgentProvider } from "./types.js";

/**
 * Places looked-up song facts without needing a language model.
 *
 * The store resolves facts before any provider runs, so when they're present
 * the common request — "add the metadata for X to the title slide" — is fully
 * determined and costs nothing.
 */
function opsFromFacts(input: string, facts: NonNullable<Parameters<typeof factsSummary>[0]>): Op[] {
  if (/\b(?:create|make|build|generate)\b[\s\S]*\b(?:new\s+)?first\s+slide\b/i.test(input)) {
    return [
      {
        op: "createSlides",
        at: 0,
        slides: [
          {
            name: facts.title,
            title: facts.title,
            body: factsSummary(facts),
            layout: "centered",
          },
        ],
      },
    ];
  }

  // A destination named in the instruction wins; otherwise the first slide,
  // which is where a title and its credits belong.
  const destination = /\b(?:to|on|in|into|onto)\s+(?:the\s+)?(.+)$/i.exec(input)?.[1];
  const target = (destination && parseTarget(destination)) || { by: "index" as const, indexes: [0] };

  return [
    { op: "setTitle", target, text: facts.title },
    { op: "appendBody", target, text: factsSummary(facts) },
  ];
}

/**
 * The default engine: the deterministic command grammar.
 *
 * Always available — no account, no key, no network, no model download — and
 * it answers in under a millisecond. This is why the common instructions were
 * shaped to land here rather than at a language model.
 */
export const deterministicProvider: AgentProvider = {
  id: "parser",
  label: "Built-in",
  description: "Instant, offline, free. Understands the documented command shapes.",
  available: () => true,
  async run(input, { deck, facts, selectedElementIds }) {
    // Facts resolved up front make this request fully determined, so it never
    // needs to reach a language model.
    if (facts) return { ok: true, ops: opsFromFacts(input, facts) };
    return parseCommand(input, deck, selectedElementIds);
  },
};
