import { ModelReply, needsLookup } from "../ops.js";
import { opListJsonSchema, systemPrompt } from "../prompt.js";
import type { AgentProvider } from "./types.js";

/**
 * Any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Deliberately generic rather than hard-wired to OpenAI, because the endpoint
 * is what decides who pays:
 *
 *  - **Ollama / LM Studio on localhost** — free, private, offline, no account.
 *    This is the option that honours "no additional charges" outright.
 *  - **OpenAI, Groq, OpenRouter, …** — the user's own key, so the cost is
 *    theirs and there is no billing relationship with this app at all.
 *
 * Same request shape for all of them, so one file covers every case and the
 * choice becomes a settings field instead of a code change.
 *
 * The key lives in localStorage: it is the user's own credential on their own
 * machine, never transmitted anywhere except the endpoint they chose.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = "libre-off:llm-config";

export const LLM_PRESETS: Array<{ label: string; hint: string; config: LlmConfig }> = [
  {
    label: "Ollama (local, free)",
    hint: "Runs on your machine. Install Ollama, then: ollama pull llama3.1",
    config: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model: "llama3.1" },
  },
  {
    label: "OpenAI",
    hint: "Your own API key from platform.openai.com. You pay per use.",
    config: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  },
  {
    label: "Groq",
    hint: "Your own key from console.groq.com. Has a free tier.",
    config: {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "",
      model: "llama-3.3-70b-versatile",
    },
  },
];

/**
 * Config from `.env`, if a key was supplied there.
 *
 * Vite substitutes `VITE_*` at build time, so this is a convenience for
 * running locally — the value ends up as a literal in the bundle and is not
 * secret. See `.env.example`.
 */
export function envLlmConfig(): LlmConfig | null {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY?.trim();
  // A key left at the template's placeholder counts as "not configured",
  // so copying `.env.example` without editing it doesn't produce 401s.
  if (!apiKey || apiKey.startsWith("sk-proj-replace-me")) return null;
  return {
    apiKey,
    baseUrl: import.meta.env.VITE_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    model: import.meta.env.VITE_OPENAI_MODEL?.trim() || "gpt-4o-mini",
  };
}

/**
 * The config in effect. A config saved through the ⚙ settings wins, so the
 * UI can always override `.env` without editing files and restarting; absent
 * that, `.env` is the default.
 */
export function loadLlmConfig(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      if (parsed.baseUrl && parsed.model) {
        return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey ?? "", model: parsed.model };
      }
    }
  } catch {
    // Fall through to `.env` — a corrupt saved config shouldn't disable the
    // assistant when a perfectly good key exists in the environment.
  }
  return envLlmConfig();
}

export function saveLlmConfig(config: LlmConfig | null): void {
  try {
    if (config) localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-browsing modes can refuse writes; the provider just stays off.
  }
}

/** Pulls the first JSON object out of a reply, tolerating ```json fences. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Some models prepend a sentence despite instructions; salvage the object.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in the reply");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export const openAiCompatibleProvider: AgentProvider = {
  id: "llm",
  label: "Language model",
  description:
    "Handles free-form phrasing, typos and multi-part instructions. Point it at a local Ollama (free) or your own API key.",

  available: () => loadLlmConfig() !== null,

  async run(input, { deck, facts, currentSlide, selectedElementIds, lookupOutcome }) {
    const config = loadLlmConfig();
    if (!config) {
      return { ok: false, reason: "error", message: "No language model is configured." };
    }

    const body = {
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt(deck, facts, currentSlide, selectedElementIds, lookupOutcome),
        },
        { role: "user", content: input },
      ],
      // Ask for schema-constrained output where supported. Endpoints that
      // ignore this still usually return JSON because the prompt insists, and
      // `extractJson` + Zod catch whatever comes back either way.
      response_format: {
        type: "json_schema",
        json_schema: { name: "deck_ops", strict: false, schema: opListJsonSchema() },
      },
    };

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message:
          `Couldn't reach ${config.baseUrl}. ` +
          (config.baseUrl.includes("localhost")
            ? "Is Ollama running? It also needs to allow this page's origin (OLLAMA_ORIGINS)."
            : `${err instanceof Error ? err.message : String(err)}`),
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        message: `${config.model} returned ${response.status}. ${detail.slice(0, 200)}`,
      };
    }

    let raw: unknown;
    try {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty reply");
      raw = extractJson(content);
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: `Couldn't read the model's reply: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const parsed = ModelReply.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: "error",
        message: `The model proposed something this app can't do${
          issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""
        }.`,
      };
    }

    const reply = parsed.data;
    const message = reply.message?.trim() ?? "";

    // A lookup request only counts on the first pass. Honouring it after one
    // has already been answered would let a model that dislikes the result
    // search forever; one round trip is the whole contract.
    if (reply.lookup && !lookupOutcome) {
      return needsLookup(reply.lookup.query, reply.lookup.reason);
    }

    const ops = reply.ops ?? [];
    if (ops.length === 0 && !message) {
      return {
        ok: false,
        reason: "unparsed",
        message: "The model returned neither an answer nor an edit plan. Try rephrasing the request.",
      };
    }

    return { ok: true, ops, ...(message ? { message } : {}) };
  },
};

/** Exposed for the settings UI's "test connection" button. */
export async function testLlmConfig(config: LlmConfig): Promise<string | null> {
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 5,
        messages: [{ role: "user", content: "reply with OK" }],
      }),
    });
    if (!response.ok) return `${response.status}: ${(await response.text()).slice(0, 160)}`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
