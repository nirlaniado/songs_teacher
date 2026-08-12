import { lazy, Suspense, useEffect, useState } from "react";
import { useDeckStore } from "./store/deckStore.js";
import { useLibraryStore } from "./store/libraryStore.js";
import { DeckLibraryScreen } from "./components/DeckLibraryScreen.js";
import { DeckScreen } from "./components/DeckScreen.js";
import { LibraryScreen } from "./components/LibraryScreen.js";
import { SongScreen } from "./components/SongScreen.js";

// Cytoscape (+ fcose) is the heaviest dependency in the app and is only ever
// needed on the graph screen — code-split it out of the main bundle instead
// of paying for it on every load.
const GraphView = lazy(() => import("./components/GraphView.js").then((m) => ({ default: m.GraphView })));

type Screen = "decks" | "editor" | "songs" | "graph";

export default function App() {
  const [screen, setScreen] = useState<Screen>("decks");

  const supported = useDeckStore((s) => s.supported);
  const usingFallbackStorage = useDeckStore((s) => s.usingFallbackStorage);
  const attached = useDeckStore((s) => s.attached);
  const attaching = useDeckStore((s) => s.attaching);
  const error = useDeckStore((s) => s.error);
  const attach = useDeckStore((s) => s.attach);
  const restoreOnLoad = useDeckStore((s) => s.restoreOnLoad);

  const currentSong = useLibraryStore((s) => s.currentSong);
  const restoreSongs = useLibraryStore((s) => s.restoreOnLoad);

  // Best-effort silent reattach. Chromium persists the directory handle but
  // drops the permission grant, so this often fails — that's expected, and
  // the "Open library" button below is what the flow falls back to. It must
  // stay behind a real click: calling attach() outside a user gesture throws.
  useEffect(() => {
    void restoreOnLoad();
  }, [restoreOnLoad]);

  // Both stores share one adapter instance, so this only syncs the song
  // store's own view of attachment — it never prompts a second time.
  useEffect(() => {
    if (attached) void restoreSongs();
  }, [attached, restoreSongs]);

  if (!supported) {
    return (
      <Centered>
        <p className="max-w-sm text-center text-sm text-neutral-400">
          This browser has neither the File System Access API nor IndexedDB, so there's
          nowhere for libre-off to keep your presentations. Try a different browser.
        </p>
      </Centered>
    );
  }

  if (!attached) {
    return (
      <Centered>
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold text-neutral-100">libre-off</h1>
          <p className="text-sm text-neutral-400">
            Presentations that follow the music — build slides, attach a song, and cue each
            slide to a moment in the track.
          </p>
          <p className="text-sm text-neutral-500">
            {usingFallbackStorage
              ? "This browser can't open a real folder, so your work is stored inside the browser instead."
              : "Choose a folder to keep your presentations in."}
          </p>
          {usingFallbackStorage && (
            <p className="text-xs text-neutral-600">
              That means no folder to back up or open directly, and clearing site data wipes
              it. Chrome, Edge, or Brave keep everything as real files on disk.
            </p>
          )}
          <button
            onClick={() => void attach()}
            disabled={attaching}
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {attaching ? "Opening…" : usingFallbackStorage ? "Get started" : "Open folder"}
          </button>
          {error && <p className="max-w-sm text-center text-xs text-red-400">{error}</p>}
        </div>
      </Centered>
    );
  }

  if (screen === "editor") return <DeckScreen onBack={() => setScreen("decks")} />;

  // ── song-study mode (the earlier analysis tool, kept alongside) ──────────
  if (screen === "songs" || screen === "graph") {
    if (currentSong) return <SongScreen />;
    if (screen === "graph") {
      return (
        <Suspense
          fallback={
            <Centered>
              <p className="text-sm text-neutral-500">Loading graph…</p>
            </Centered>
          }
        >
          <GraphView onBack={() => setScreen("songs")} />
        </Suspense>
      );
    }
    return (
      <div>
        <div className="border-b border-neutral-800 px-6 py-2">
          <button
            onClick={() => setScreen("decks")}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            ← Presentations
          </button>
        </div>
        <LibraryScreen onViewGraph={() => setScreen("graph")} />
      </div>
    );
  }

  return (
    <div>
      <DeckLibraryScreen onOpen={() => setScreen("editor")} />
      <div className="mx-auto max-w-3xl px-10 pb-10">
        <button
          onClick={() => setScreen("songs")}
          className="text-xs text-neutral-600 hover:text-neutral-400"
        >
          Song study tools →
        </button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center px-6">{children}</div>;
}
