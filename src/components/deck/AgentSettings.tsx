import { useState } from "react";
import {
  LLM_PRESETS,
  envLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
  testLlmConfig,
  type LlmConfig,
} from "../../agent/providers/index.js";

/**
 * Points the assistant at a language model.
 *
 * Any OpenAI-compatible `/chat/completions` endpoint works, which is what
 * makes the cost question the user's to answer rather than ours: a local
 * Ollama is free and offline, a hosted key is theirs to pay for. The key is
 * stored in this browser only and sent nowhere but the endpoint chosen here.
 */
export function AgentSettings({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<LlmConfig>(
    () => loadLlmConfig() ?? LLM_PRESETS[0]!.config,
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Whether a key came from `.env`, and whether it is the one currently in
  // effect. Without this the panel can't explain why the assistant already
  // works on a machine where nothing was ever entered here.
  const fromEnv = envLlmConfig();
  const usingEnv = fromEnv !== null && localStorage.getItem("libre-off:llm-config") === null;

  const field =
    "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200";
  const label = "block text-[11px] text-neutral-500";

  async function test() {
    setTesting(true);
    setResult(null);
    const error = await testLlmConfig(config);
    setTesting(false);
    setResult(error ?? "ok");
  }

  return (
    <div className="space-y-2 border-b border-neutral-800 bg-neutral-950/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Language model
        </span>
        <button onClick={onClose} className="text-[11px] text-neutral-500 hover:text-neutral-300">
          Close
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-600">
        Without one, the assistant only understands its built-in command shapes. With one, it
        handles free-form phrasing, typos and multi-part instructions.
      </p>

      {usingEnv && (
        <p className="rounded border border-emerald-900 bg-emerald-950/40 px-2 py-1 text-[10px] text-emerald-300">
          Using the key from <code>.env</code> ({fromEnv.model}). Saving below overrides it for
          this browser; Disable reverts to <code>.env</code>.
        </p>
      )}

      <div className="flex gap-1">
        {LLM_PRESETS.map((preset) => (
          <button
            key={preset.label}
            title={preset.hint}
            onClick={() => {
              setConfig(preset.config);
              setResult(null);
            }}
            className={`flex-1 rounded px-1.5 py-1 text-[10px] ${
              config.baseUrl === preset.config.baseUrl
                ? "bg-sky-700 text-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {LLM_PRESETS.find((p) => p.config.baseUrl === config.baseUrl)?.hint && (
        <p className="text-[10px] text-neutral-600">
          {LLM_PRESETS.find((p) => p.config.baseUrl === config.baseUrl)?.hint}
        </p>
      )}

      <label className={label}>
        Endpoint
        <input
          value={config.baseUrl}
          onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
          className={`${field} mt-0.5`}
          placeholder="http://localhost:11434/v1"
        />
      </label>

      <label className={label}>
        Model
        <input
          value={config.model}
          onChange={(e) => setConfig({ ...config, model: e.target.value })}
          className={`${field} mt-0.5`}
          placeholder="llama3.1"
        />
      </label>

      <label className={label}>
        API key <span className="text-neutral-700">(leave blank for local models)</span>
        <input
          type="password"
          value={config.apiKey}
          onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
          className={`${field} mt-0.5`}
          placeholder="sk-…"
        />
      </label>

      <p className="text-[10px] text-neutral-600">
        Stored in this browser only, and sent nowhere except the endpoint above.
      </p>

      {result && (
        <p
          className={`rounded border px-2 py-1 text-[10px] ${
            result === "ok"
              ? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
              : "border-red-900 bg-red-950/40 text-red-300"
          }`}
        >
          {result === "ok" ? "Connected." : result}
        </p>
      )}

      <div className="flex gap-1">
        <button
          onClick={() => void test()}
          disabled={testing}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          onClick={() => {
            saveLlmConfig(config);
            onClose();
          }}
          className="flex-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white"
        >
          Save
        </button>
        <button
          onClick={() => {
            saveLlmConfig(null);
            setResult(null);
            onClose();
          }}
          // Clearing the saved config falls back to `.env`, so it only truly
          // disables the model when there's no key there to fall back to.
          title={
            fromEnv
              ? "Forget the saved config and go back to the key in .env"
              : "Stop using a language model"
          }
          className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-700"
        >
          {fromEnv ? "Reset" : "Disable"}
        </button>
      </div>
    </div>
  );
}
