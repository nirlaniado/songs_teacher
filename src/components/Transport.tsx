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
    <div className="flex items-center gap-4 rounded-lg border border-line bg-panel px-4 py-2">
      <button
        onClick={() => transport?.playPause()}
        disabled={!transport}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>

      <span className="tabular-nums text-sm text-muted">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <label
        className={`flex items-center gap-1.5 text-sm ${
          activeSectionId ? "text-muted" : "text-faint"
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
        {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
        <span className="truncate text-sm text-faint">{title}</span>
        <button
          onClick={() => void saveSong()}
          disabled={!dirty || saving}
          className="rounded bg-raised px-3 py-1 text-sm text-fg disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
