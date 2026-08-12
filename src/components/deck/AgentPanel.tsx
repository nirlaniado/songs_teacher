import { useEffect, useMemo, useRef, useState } from "react";
import { EXAMPLE_COMMANDS } from "../../agent/parse/grammar.js";
import { availableProviders } from "../../agent/providers/index.js";
import { AgentSettings } from "./AgentSettings.js";
import { useAgentStore } from "../../store/agentStore.js";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * The assistant panel.
 *
 * An instruction never edits the deck directly — it produces a plan the user
 * reads and confirms. The plan lines name the *resolved* slides ("Verse 1,
 * Verse 2, Verse 3"), so a misread target is visible before anything changes.
 */
export function AgentPanel() {
  const running = useAgentStore((s) => s.running);
  const pending = useAgentStore((s) => s.pending);
  const message = useAgentStore((s) => s.message);
  const lookupChoice = useAgentStore((s) => s.lookupChoice);
  const transcript = useAgentStore((s) => s.transcript);
  const submit = useAgentStore((s) => s.submit);
  const chooseSong = useAgentStore((s) => s.chooseSong);
  const rejectCandidates = useAgentStore((s) => s.rejectCandidates);
  const applyPending = useAgentStore((s) => s.applyPending);
  const discardPending = useAgentStore((s) => s.discardPending);
  const hasDeck = useDeckStore((s) => s.deck !== null);

  const [text, setText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  // Bumped when the model config changes, to recompute provider availability.
  const [providerEpoch, setProviderEpoch] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // NOT a store selector. `PROVIDERS.filter(...)` builds a new array each
  // call, and Zustand compares selector results with Object.is — so selecting
  // it would report a change on every render and loop until React bails out
  // (which blanks the panel). Availability depends on the environment and on
  // saved config, not on store state, so it belongs in a memo.
  const providers = useMemo(() => availableProviders(), [providerEpoch]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [transcript, pending, message, lookupChoice]);

  function send() {
    const instruction = text.trim();
    if (!instruction || running) return;
    void submit(instruction);
    setText("");
  }

  if (!hasDeck) return null;

  return (
    <aside className="flex h-full w-80 flex-col border-l border-neutral-800 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Assistant
        </span>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] text-neutral-600"
            title={providers.map((p) => `${p.label}: ${p.description}`).join("\n")}
          >
            {providers.map((p) => p.label).join(" · ")}
          </span>
          <button
            onClick={() => setShowSettings((v) => !v)}
            title="Connect a language model"
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            ⚙
          </button>
        </div>
      </div>

      {showSettings && (
        <AgentSettings
          onClose={() => {
            setShowSettings(false);
            // Availability is read at module level from localStorage, so the
            // provider list has to be recomputed after the config changes.
            setProviderEpoch((n) => n + 1);
          }}
        />
      )}

      <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {transcript.length === 0 && !pending && !message && (
          <div className="space-y-2">
            <p className="text-xs text-neutral-500">
              Describe what you want and I'll build it. I operate the editor — I don't
              analyse music, so chords and lyrics are placed exactly as you type them.
            </p>
            <div className="space-y-1">
              {EXAMPLE_COMMANDS.map((example) => (
                <button
                  key={example}
                  onClick={() => {
                    setText(example);
                    inputRef.current?.focus();
                  }}
                  className="block w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-left text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {transcript.map((entry, i) => (
          <div key={i} className="space-y-1">
            <p className="text-[11px] text-neutral-300">
              <span className="text-neutral-600">›</span> {entry.instruction}
            </p>
            <p className={`text-[11px] ${entry.ok ? "text-emerald-500" : "text-amber-500"}`}>
              {entry.outcome}
            </p>
          </div>
        ))}

        {message && !pending && (
          <p className="rounded border border-amber-900 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-300">
            {message}
          </p>
        )}

        {/* Genius found things, but nothing the scorer trusts. Asking is the
            only honest option: the top hit is often a cover, a remix, or a
            user's collection page indexed as a song. */}
        {lookupChoice && (
          <div className="rounded border border-amber-800 bg-amber-950/30 p-2">
            <p className="text-[11px] font-medium text-amber-300">
              I'm not sure which song you mean.
            </p>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              Searched Genius for “{lookupChoice.query}”. Nothing matched closely enough to
              use without asking.
            </p>

            <ul className="mt-2 space-y-1">
              {lookupChoice.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    onClick={() => void chooseSong(candidate)}
                    disabled={running}
                    className="block w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-left hover:border-amber-700 disabled:opacity-40"
                  >
                    <span className="block text-[11px] text-neutral-200">{candidate.title}</span>
                    <span className="block text-[10px] text-neutral-500">
                      {candidate.artist}
                      {candidate.year ? ` · ${candidate.year}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <button
              onClick={() => void rejectCandidates()}
              disabled={running}
              className="mt-1.5 w-full rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
            >
              None of these
            </button>
          </div>
        )}

        {pending && (
          <div className="rounded border border-sky-800 bg-sky-950/30 p-2">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-medium text-sky-300">Proposed changes</span>
              <span className="text-[10px] text-neutral-600">{pending.providerLabel}</span>
            </div>

            <ul className="space-y-1">
              {pending.lines.map((line, i) => (
                <li
                  key={i}
                  className={`text-[11px] ${
                    line.destructive
                      ? "text-red-300"
                      : line.empty
                        ? "text-amber-400"
                        : "text-neutral-300"
                  }`}
                >
                  • {line.text}
                  {line.empty && <span className="ml-1 text-amber-500">(matches nothing)</span>}
                </li>
              ))}
            </ul>

            {pending.error && (
              <p className="mt-2 rounded border border-red-900 bg-red-950/50 px-2 py-1 text-[11px] text-red-300">
                Can't apply: {pending.error}
              </p>
            )}

            {pending.notice && !pending.error && (
              <p className="mt-2 rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-300">
                {pending.notice}
              </p>
            )}

            <div className="mt-2 flex gap-1">
              <button
                onClick={applyPending}
                disabled={pending.error !== null}
                className="flex-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
              >
                Apply
              </button>
              <button
                onClick={discardPending}
                className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-2">
        <div className="flex gap-1">
          {/* A textarea, not an input: pasting multi-line text into an input
              collapses it to one line, which breaks pasting a whole song's
              worth of [Section]-tagged content. */}
          <textarea
            ref={inputRef}
            value={text}
            rows={text.includes("\n") ? 6 : 2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={"e.g. add chords C D E F to verses 1 2 3\n(Shift+Enter for a new line)"}
            className="flex-1 resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600"
          />
          <button
            onClick={send}
            disabled={running || text.trim() === ""}
            className="self-end rounded bg-sky-700 px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            {running ? "…" : "Go"}
          </button>
        </div>
      </div>
    </aside>
  );
}
