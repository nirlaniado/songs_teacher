import { OpList } from "../ops.js";
import type { AgentProvider } from "./types.js";

/**
 * Drives the user's own installed, logged-in Codex CLI.
 *
 * WHY THIS SHAPE, and not an OAuth flow inside libre-off:
 *
 * "Sign in with ChatGPT" is an identity provider — it returns name, email and
 * profile picture. It grants no inference. Subscription-backed model calls are
 * a first-party capability of OpenAI's own clients (Codex CLI, the IDE
 * extension, Codex Cloud). Asked directly whether a third-party client may do
 * the same, OpenAI declined to confirm it, and their terms restrict accessing
 * the service by automated or programmatic means.
 *
 * So we never reimplement that OAuth flow. Doing so would mean presenting
 * OpenAI's first-party client credentials from a client that isn't theirs, it
 * breaks the moment they rotate a client id, and the enforcement exposure
 * lands on the *user's* ChatGPT account rather than ours.
 *
 * Invoking the official CLI the user installed and logged into themselves is
 * a different thing entirely: nothing is forged, it is OpenAI's own client,
 * the user's own login, on their own machine. `codex exec --output-schema`
 * constrains the reply to a JSON Schema, which is exactly the op list we
 * need, and it costs nothing against an API account.
 *
 * NOT AVAILABLE IN THE BROWSER: a tab cannot spawn a subprocess. This turns
 * on in the Electron build, where `runCodex` will be added to
 * `LibraryAdapter` — keeping `child_process` inside the adapter layer, per
 * hard rule #1.
 */

/** Present only under Electron; the browser build has no subprocess access. */
interface CodexBridge {
  runCodex(prompt: string, schema: unknown): Promise<string>;
}

function bridge(): CodexBridge | undefined {
  return (globalThis as unknown as { codexBridge?: CodexBridge }).codexBridge;
}

export const codexCliProvider: AgentProvider = {
  id: "codex",
  label: "Codex CLI",
  description:
    "Uses the Codex CLI you already installed and signed into, so calls run on your ChatGPT plan with no API charges. Desktop build only.",

  available: () => bridge() !== undefined,

  async run(input, { deck, facts, currentSlide, selectedElementIds }) {
    const host = bridge();
    if (!host) {
      return {
        ok: false,
        reason: "error",
        message: "Codex CLI is only available in the desktop build.",
      };
    }

    // Imported lazily so the browser bundle doesn't carry the prompt builder
    // and JSON-Schema conversion for a provider it can never run.
    const { systemPrompt, opListJsonSchema } = await import("../prompt.js");

    try {
      const raw = await host.runCodex(
        `${systemPrompt(deck, facts, currentSlide, selectedElementIds)}\n\nINSTRUCTION: ${input}`,
        opListJsonSchema(),
      );
      const reply = JSON.parse(raw) as { ops?: unknown; message?: unknown };
      const parsed = OpList.safeParse(reply.ops);
      if (!parsed.success) {
        return { ok: false, reason: "error", message: "Codex returned something unexpected." };
      }
      const message = typeof reply.message === "string" ? reply.message.trim() : "";
      if (parsed.data.length === 0 && !message) {
        return { ok: false, reason: "unparsed", message: "Codex returned neither an answer nor edits." };
      }
      return { ok: true, ops: parsed.data, ...(message ? { message } : {}) };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
