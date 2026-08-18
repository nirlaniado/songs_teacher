import { useEffect, useState } from "react";
import { getProject, slideUrl, LokClientError, type LokProject, type SlideCue } from "../../lok/client.js";
import { LokCanvas } from "./LokCanvas.js";
import { LokPresentMode } from "./LokPresentMode.js";
import { LokTimingPanel } from "./LokTimingPanel.js";
import { LokToolbar } from "./LokToolbar.js";

/**
 * The LibreOffice-backed editor — Stage 2/3, entirely additive. Nothing here
 * touches `deckStore`, `SlideCanvas`, or any existing screen; this is a
 * parallel path reachable only from the new entry point in App.tsx, exactly
 * the "build alongside, cut over once proven" shape the plan called for.
 *
 * Requires `npm run lok:server` running in a second terminal (and
 * `npm run lok:host:build` once beforehand) — this screen does not, and per
 * hard rule #1 cannot, spawn that process itself from browser code.
 */
export function LokDeckScreen({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<LokProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [presenting, setPresenting] = useState(false);

  async function refresh() {
    try {
      const project = await getProject();
      setState(project);
      setError(null);
      setSlideIndex((i) => Math.min(i, project.slideCount - 1));
    } catch (e) {
      setError(e instanceof LokClientError ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function setRevision(index: number, revision: number) {
    setState((s) => {
      if (!s) return s;
      const next = [...s.revision];
      next[index] = revision;
      return { ...s, revision: next };
    });
  }

  function setSlideSync(slideSync: SlideCue[]) {
    setState((s) => (s ? { ...s, project: { ...s.project, slideSync } } : s));
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-red-400">{error}</p>
        <p className="max-w-sm text-xs text-neutral-500">
          Start it with <code className="rounded bg-neutral-800 px-1">npm run lok:host:build</code>{" "}
          once, then <code className="rounded bg-neutral-800 px-1">npm run lok:server</code> in a
          second terminal.
        </p>
        <div className="flex gap-2">
          <button onClick={() => void refresh()} className="rounded bg-neutral-700 px-3 py-1.5 text-sm text-white">
            Retry
          </button>
          <button onClick={onBack} className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-300">
            ← Back
          </button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-neutral-500">Connecting to the LOK server…</p>
      </div>
    );
  }

  if (presenting) {
    return (
      <LokPresentMode
        slideNames={state.slideNames}
        slideSync={state.project.slideSync}
        revision={state.revision}
        hasAudio={state.project.audio !== null}
        onExit={() => setPresenting(false)}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <button onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Presentations
        </button>
        <span className="text-xs text-neutral-600">
          LibreOffice editor (experimental) — {state.slideCount} slide{state.slideCount === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => setPresenting(true)}
          className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
        >
          ▶ Present
        </button>
      </div>

      <LokToolbar
        slideIndex={slideIndex}
        slideCount={state.slideCount}
        busy={busy}
        setBusy={setBusy}
        onRerender={() => setRevision(slideIndex, (state.revision[slideIndex] ?? 0) + 1)}
        onSlideMutated={() => void refresh()}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="w-40 shrink-0 overflow-y-auto border-r border-neutral-800 p-2">
          {state.slideNames.map((name, i) => (
            <button
              key={i}
              onClick={() => setSlideIndex(i)}
              className={`mb-2 block w-full overflow-hidden rounded border text-left ${
                i === slideIndex ? "border-emerald-500" : "border-neutral-800"
              }`}
            >
              <img src={slideUrl(i, state.revision[i] ?? 0)} alt={name} className="aspect-video w-full bg-white" />
              <div className="truncate bg-neutral-900 px-1 py-0.5 text-[10px] text-neutral-400">{name}</div>
            </button>
          ))}
        </aside>

        <main className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-4xl">
            <LokCanvas
              slideIndex={slideIndex}
              docSize={state.docSizeTwips}
              revision={state.revision[slideIndex] ?? 0}
              onRevisionChange={(rev) => setRevision(slideIndex, rev)}
            />
          </div>
        </main>
      </div>

      <LokTimingPanel
        hasAudio={state.project.audio !== null}
        slideNames={state.slideNames}
        slideSync={state.project.slideSync}
        activeSlide={slideIndex}
        onAudioAttached={() => void refresh()}
        onCuesChanged={setSlideSync}
      />
    </div>
  );
}
