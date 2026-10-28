import { useEffect } from "react";
import { useLibraryStore } from "../store/libraryStore.js";
import { usePlayerStore } from "../store/playerStore.js";
import { Waveform } from "./Waveform.js";
import { Transport } from "./Transport.js";
import { SectionList } from "./SectionList.js";
import { SlideView } from "./SlideView.js";

/** The vertical slice: one song, its player, its sections, its driven slide. */
export function SongScreen() {
  const song = useLibraryStore((s) => s.currentSong);
  const audioHandle = useLibraryStore((s) => s.audioHandle);
  const closeSong = useLibraryStore((s) => s.closeSong);
  const isDirty = useLibraryStore((s) => s.isDirty);
  const resetPlayer = usePlayerStore((s) => s.reset);

  // Reset the playback clock when leaving a song, so a stale activeSectionId
  // from the previous song can't briefly flash on the next one.
  useEffect(() => () => resetPlayer(), [resetPlayer]);

  if (!song) return null;
  // Audio must be resolved before the waveform can mount. A song with no
  // audio at all (migrated from a removed YouTube source) still opens —
  // its sections and analysis are intact, there is just nothing to play.
  if (song.audio && !audioHandle) return null;

  function handleClose() {
    if (isDirty() && !confirm("You have unsaved changes. Close anyway?")) return;
    closeSong();
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <button onClick={handleClose} className="text-sm text-faint hover:text-muted">
          ← Library
        </button>
        <div className="text-right">
          <h1 className="text-lg font-semibold text-fg">{song.title}</h1>
          {song.artist && <p className="text-xs text-faint">{song.artist}</p>}
        </div>
      </div>

      {song.audio && audioHandle ? (
        <Waveform audioUrl={audioHandle.url} />
      ) : (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
          This song has no audio file. Its sections and analysis are intact — see the notes
          for where the audio used to come from.
        </div>
      )}
      <Transport />

      <div className="grid flex-1 grid-cols-[280px_1fr] gap-4 overflow-hidden">
        <div className="overflow-hidden">
          <SectionList />
        </div>
        <SlideView />
      </div>
    </div>
  );
}
