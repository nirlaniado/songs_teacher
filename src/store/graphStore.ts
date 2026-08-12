import { create } from "zustand";
import { buildGraphIndex, type GraphIndex } from "../graph/index.js";
import { useLibraryStore } from "./libraryStore.js";

/**
 * The graph is index data (hard rule #2): nothing here is persisted, it's
 * rebuilt from the library on demand. `build()` reads every song's full
 * content through the adapter — `listSongs()` only returns the cheap
 * `SongSummary`, which has no `sections`/`progression` to match on.
 */
interface GraphState {
  index: GraphIndex | null;
  loading: boolean;
  error: string | null;
  build(): Promise<void>;
}

export const useGraphStore = create<GraphState>((set) => ({
  index: null,
  loading: false,
  error: null,

  async build() {
    const { adapter, songs } = useLibraryStore.getState();
    set({ loading: true, error: null });
    try {
      const fullSongs = await Promise.all(songs.map((s) => adapter.readSong(s.id)));
      set({ index: buildGraphIndex(fullSongs), loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
