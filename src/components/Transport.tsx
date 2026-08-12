import { usePlayerStore } from "../store/playerStore.js";
import { useLibraryStore } from "../store/libraryStore.js";

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Play/pause, loop-section toggle, live time readout, and save. */
export function Transport() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const loopEnabled = usePlayerStore((s) => s.loopEnabled);
  const setLoopEnabled = usePlayerStore((s) => s.setLoopEnabled);
  const transport = usePlayerStore((s) => s.transport);
  // The one place allowed to read currentTime at 60fps: this readout, and
  // only this readout, re-renders on every tick (Zustand only re-renders
  // components whose *selected* slice actually changed).
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const activeSectionId = usePlayerStore((s) => s.activeSectionId);

  const saveSong = useLibraryStore((s) => s.saveSong);
  const saving = useLibraryStore((s) => s.saving);
  const dirty = useLibraryStore((s) => s.isDirty());
  const title = useLibraryStore((s) => s.currentSong?.title ?? "");

  return (
    <div className="flex items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-2">
      <button
        onClick={() => transport?.playPause()}
        disabled={!transport}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-700 text-white disabled:opacity-40"
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>

      <span className="tabular-nums text-sm text-neutral-400">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <label
        className={`flex items-center gap-1.5 text-sm ${
          activeSectionId ? "text-neutral-300" : "text-neutral-600"
        }`}
        title={
          activeSectionId
            ? "Loop the section currently under the playhead"
            : "Loop needs the playhead inside a section"
        }
      >
        <input
          type="checkbox"
          checked={loopEnabled}
          disabled={!activeSectionId && !loopEnabled}
          onChange={(e) => setLoopEnabled(e.target.checked)}
        />
        Loop section
      </label>

      <div className="ml-auto flex items-center gap-2">
        {dirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
        <span className="truncate text-sm text-neutral-500">{title}</span>
        <button
          onClick={() => void saveSong()}
          disabled={!dirty || saving}
          className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
