import { useRef, useState } from "react";
import { useDeckStore } from "../store/deckStore.js";

/**
 * The start screen — the list of presentations, plus "new". Roughly the role
 * LibreOffice's Start Center plays.
 */
export function DeckLibraryScreen({ onOpen }: { onOpen: () => void }) {
  const decks = useDeckStore((s) => s.decks);
  const loading = useDeckStore((s) => s.loadingDecks);
  const error = useDeckStore((s) => s.error);
  const createDeck = useDeckStore((s) => s.createDeck);
  const openDeck = useDeckStore((s) => s.openDeck);
  const deleteDeck = useDeckStore((s) => s.deleteDeck);
  const detach = useDeckStore((s) => s.detach);
  const usingFallbackStorage = useDeckStore((s) => s.usingFallbackStorage);

  const importDeck = useDeckStore((s) => s.importDeck);

  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const bundleInput = useRef<HTMLInputElement>(null);

  async function handleImport(file: File) {
    setImporting(true);
    try {
      await importDeck(file);
      onOpen();
    } finally {
      setImporting(false);
    }
  }

  async function create() {
    const name = title.trim() || "Untitled presentation";
    setCreating(true);
    try {
      await createDeck(name);
      setTitle("");
      onOpen();
    } finally {
      setCreating(false);
    }
  }

  async function open(id: string) {
    await openDeck(id);
    onOpen();
  }


  return (
    <div className="mx-auto max-w-3xl p-10">
      <div className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg">Presentations</h1>
          <p className="mt-1 text-sm text-faint">
            Slides that follow the music — build a deck, attach an MP3, cue each slide to a
            moment in the song.
          </p>
        </div>
        <button onClick={() => void detach()} className="text-sm text-faint hover:text-muted">
          Close library
        </button>
      </div>

      {usingFallbackStorage && (
        <p className="mb-4 rounded border border-line bg-panel px-3 py-2 text-xs text-faint">
          This browser can't open a real folder, so presentations are stored inside the browser.
          Clearing site data will delete them. Chrome, Edge, or Brave keep them as files on disk.
        </p>
      )}

      {error && (
        <p className="mb-4 rounded border border-danger-soft bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="mb-8 flex gap-2"
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New presentation title"
          className="flex-1 rounded border border-line bg-canvas px-3 py-2 text-sm text-fg"
        />
        <button
          type="submit"
          disabled={creating}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => bundleInput.current?.click()}
          disabled={importing}
          title="Open a .zip exported from songs-teacher"
          className="rounded bg-raised px-4 py-2 text-sm text-fg hover:bg-raised-hover disabled:opacity-50"
        >
          {importing ? "Importing…" : "Import…"}
        </button>
        <input
          ref={bundleInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = "";
          }}
        />
      </form>

      {loading && <p className="text-sm text-faint">Loading…</p>}
      {!loading && decks.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-faint">
          No presentations yet. Name one above and hit Create.
        </p>
      )}

      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {decks.map((deck) => (
          <li key={deck.id} className="flex items-center gap-3 px-4 py-3 hover:bg-panel">
            <button onClick={() => void open(deck.id)} className="flex-1 text-left">
              <div className="font-medium text-fg">{deck.title}</div>
              <div className="text-xs text-faint">
                {deck.slideCount} slide{deck.slideCount === 1 ? "" : "s"}
                {deck.hasAudio && <span className="ml-2 text-accent-light">♪ has audio</span>}
              </div>
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete "${deck.title}"? This cannot be undone.`)) {
                  void deleteDeck(deck.id);
                }
              }}
              className="text-xs text-faint hover:text-danger"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
