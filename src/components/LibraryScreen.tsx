import { useRef, useState } from "react";
import { useLibraryStore } from "../store/libraryStore.js";
import type { KeyRef, Mode } from "../schema/song.js";

const MODES: Mode[] = [
  "major",
  "minor",
  "ionian",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "aeolian",
  "locrian",
  "harmonic-minor",
  "melodic-minor",
];

function titleFromFilename(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/** Song list + "add a song" form. Shown once a library root is attached. */
export function LibraryScreen({ onViewGraph }: { onViewGraph: () => void }) {
  const songs = useLibraryStore((s) => s.songs);
  const loadingSongs = useLibraryStore((s) => s.loadingSongs);
  const error = useLibraryStore((s) => s.error);
  const openSong = useLibraryStore((s) => s.openSong);
  const deleteSong = useLibraryStore((s) => s.deleteSong);
  const createSong = useLibraryStore((s) => s.createSong);
  const detach = useLibraryStore((s) => s.detach);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [tonic, setTonic] = useState("C");
  const [mode, setMode] = useState<Mode>("major");
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !file) return;
    const key: KeyRef = { tonic, mode };
    setImporting(true);
    try {
      await createSong(file, title.trim(), key);
      setFile(null);
      setTitle("");
      if (fileInput.current) fileInput.current.value = "";
    } finally {
      setImporting(false);
    }
  }


  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-100">Library</h1>
        <div className="flex items-center gap-4">
          <button onClick={onViewGraph} className="text-sm text-emerald-500 hover:text-emerald-400">
            Harmonic graph →
          </button>
          <button
            onClick={() => void detach()}
            className="text-sm text-neutral-500 hover:text-neutral-300"
          >
            Close library
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <form
        onSubmit={handleImport}
        className="mb-8 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4"
      >
        <div className="mb-3">
          <h2 className="text-sm font-medium text-neutral-300">Add a song</h2>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Audio file
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title) setTitle(titleFromFilename(f.name));
              }}
              className="text-sm text-neutral-300 file:mr-2 file:rounded file:border-0 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Song title"
              className="w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Key
            <input
              value={tonic}
              onChange={(e) => setTonic(e.target.value)}
              placeholder="C"
              className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={!file || title.trim() === "" || importing}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {importing ? "Adding…" : "Add"}
          </button>
        </div>
      </form>

      <h2 className="mb-3 text-sm font-medium text-neutral-300">Songs</h2>
      {loadingSongs && <p className="text-sm text-neutral-500">Loading…</p>}
      {!loadingSongs && songs.length === 0 && (
        <p className="text-sm text-neutral-600">No songs yet — add one above.</p>
      )}
      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {songs.map((song) => (
          <li key={song.id} className="flex items-center justify-between px-4 py-3">
            <button
              onClick={() => void openSong(song.id)}
              className="flex-1 text-left"
            >
              <div className="font-medium text-neutral-100">{song.title}</div>
              {song.artist && <div className="text-xs text-neutral-500">{song.artist}</div>}
            </button>
            <div className="flex items-center gap-3">
              {!song.hasAudio && (
                <span
                  title="This song has no audio file — see its notes."
                  className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-300"
                >
                  no audio
                </span>
              )}
              {song.tags.map((t) => (
                <span key={t} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {t}
                </span>
              ))}
              <button
                onClick={() => {
                  if (confirm(`Delete "${song.title}"? This cannot be undone.`)) {
                    void deleteSong(song.id);
                  }
                }}
                className="text-xs text-neutral-600 hover:text-red-400"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
