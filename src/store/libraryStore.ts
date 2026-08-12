import { create } from "zustand";
import { newSong, type KeyRef, type Section, type Song, type SongSummary } from "../schema/song.js";
import {
  sharedLibraryAdapter,
  isAnyLibrarySupported,
  isBrowserLibrarySupported,
  LibraryError,
  type AudioHandle,
  type LibraryAdapter,
} from "../adapters/index.js";

/**
 * Everything that touches `LibraryAdapter` lives here, so components never
 * import the adapter directly. `createLibraryAdapter()` already picks the
 * best adapter this browser can run — `BrowserLibraryAdapter` (real folder)
 * where the File System Access API exists, `IndexedDbLibraryAdapter`
 * (works everywhere) otherwise. Swapping in the Electron adapter for Phase 4
 * is changing what that one factory returns, not anything here.
 */

interface LibraryState {
  adapter: LibraryAdapter;
  supported: boolean;
  /** True when we fell back to IndexedDb because the real-folder adapter isn't available here. */
  usingFallbackStorage: boolean;
  attached: boolean;
  attaching: boolean;
  error: string | null;

  songs: SongSummary[];
  loadingSongs: boolean;

  currentSong: Song | null;
  /** JSON of `currentSong` as last written to disk, to detect unsaved edits. */
  savedSnapshot: string | null;
  audioHandle: AudioHandle | null;
  saving: boolean;

  restoreOnLoad(): Promise<void>;
  attach(): Promise<void>;
  detach(): Promise<void>;
  refreshSongs(): Promise<void>;

  openSong(id: string): Promise<void>;
  closeSong(): void;
  createSong(file: File, title: string, key: KeyRef): Promise<void>;
  deleteSong(id: string): Promise<void>;

  updateSong(updater: (song: Song) => Song): void;
  setAudioDuration(duration: number): void;
  addSection(start: number, end: number): string;
  removeSection(id: string): void;
  updateSection(id: string, updater: (s: Section) => Section): void;
  saveSong(): Promise<void>;
  isDirty(): boolean;
}

function messageOf(err: unknown): string {
  if (err instanceof LibraryError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  adapter: sharedLibraryAdapter(),
  supported: isAnyLibrarySupported(),
  usingFallbackStorage: !isBrowserLibrarySupported(),
  attached: false,
  attaching: false,
  error: null,

  songs: [],
  loadingSongs: false,

  currentSong: null,
  savedSnapshot: null,
  audioHandle: null,
  saving: false,

  async restoreOnLoad() {
    const { adapter } = get();
    try {
      const ok = await adapter.restore();
      set({ attached: ok });
      if (ok) await get().refreshSongs();
    } catch (err) {
      // Restoring is best-effort; a failure just leaves the "open library"
      // button on screen, which is the required fallback per the adapter's
      // own contract (restore() drops permission silently in Chromium).
      console.warn("[library] restore failed:", err);
    }
  },

  async attach() {
    const { adapter } = get();
    set({ attaching: true, error: null });
    try {
      const ok = await adapter.attach();
      set({ attached: ok, attaching: false });
      if (ok) await get().refreshSongs();
    } catch (err) {
      set({ attaching: false, error: messageOf(err) });
    }
  },

  async detach() {
    const { adapter } = get();
    get().closeSong();
    await adapter.detach();
    set({ attached: false, songs: [] });
  },

  async refreshSongs() {
    const { adapter } = get();
    set({ loadingSongs: true, error: null });
    try {
      const songs = await adapter.listSongs();
      set({ songs, loadingSongs: false });
    } catch (err) {
      set({ loadingSongs: false, error: messageOf(err) });
    }
  },

  async openSong(id) {
    const { adapter, audioHandle } = get();
    set({ error: null });
    try {
      const song = await adapter.readSong(id);
      audioHandle?.release();
      // Songs migrated from a YouTube source have no local file (see
      // migrateSong v2->v3). They still open — sections and analysis are
      // intact — there is simply nothing to play.
      const handle = song.audio ? await adapter.resolveAudio(song) : null;
      set({
        currentSong: song,
        savedSnapshot: JSON.stringify(song),
        audioHandle: handle,
      });
    } catch (err) {
      set({ error: messageOf(err) });
    }
  },

  closeSong() {
    get().audioHandle?.release();
    set({ currentSong: null, savedSnapshot: null, audioHandle: null });
  },

  async createSong(file, title, key) {
    const { adapter } = get();
    set({ error: null });
    try {
      const id = crypto.randomUUID();
      const ext = file.name.includes(".") ? file.name.split(".").pop()! : "mp3";
      const audioPath = `audio.${ext}`;
      const draft = newSong({ id, title, key, audio: { path: audioPath } });
      await adapter.writeAsset(id, audioPath, file);
      const saved = await adapter.writeSong(draft);
      await get().refreshSongs();
      await get().openSong(saved.id);
    } catch (err) {
      set({ error: messageOf(err) });
    }
  },

  async deleteSong(id) {
    const { adapter, currentSong } = get();
    try {
      await adapter.deleteSong(id);
      if (currentSong?.id === id) get().closeSong();
      await get().refreshSongs();
    } catch (err) {
      set({ error: messageOf(err) });
    }
  },

  updateSong(updater) {
    const { currentSong } = get();
    if (!currentSong) return;
    set({ currentSong: updater(currentSong) });
  },

  setAudioDuration(duration) {
    // No-op for a song with no audio file — nothing reports a duration, and
    // fabricating an `audio` object here would resurrect a source that isn't
    // there.
    get().updateSong((song) => (song.audio ? { ...song, audio: { ...song.audio, duration } } : song));
  },

  addSection(start, end) {
    const id = crypto.randomUUID();
    get().updateSong((song) => {
      const section: Section = {
        id,
        name: `Section ${song.sections.length + 1}`,
        type: "other",
        start,
        end,
        progression: [],
        blocks: [],
      };
      // Keep the array sorted by start — the schema enforces it at save time,
      // and the sync engine's binary search assumes it holds at every point.
      const sections = [...song.sections, section].sort((a, b) => a.start - b.start);
      return { ...song, sections };
    });
    return id;
  },

  removeSection(id) {
    get().updateSong((song) => ({
      ...song,
      sections: song.sections.filter((s) => s.id !== id),
    }));
  },

  updateSection(id, updater) {
    get().updateSong((song) => replaceSection(song, id, updater));
  },

  async saveSong() {
    const { adapter, currentSong } = get();
    if (!currentSong) return;
    set({ saving: true, error: null });
    try {
      const saved = await adapter.writeSong(currentSong);
      set({ currentSong: saved, savedSnapshot: JSON.stringify(saved), saving: false });
      await get().refreshSongs();
    } catch (err) {
      set({ saving: false, error: messageOf(err) });
    }
  },

  isDirty() {
    const { currentSong, savedSnapshot } = get();
    if (!currentSong) return false;
    return JSON.stringify(currentSong) !== savedSnapshot;
  },
}));

/** Convenience for components that only need to replace one section by id. */
export function replaceSection(song: Song, id: string, updater: (s: Section) => Section): Song {
  return {
    ...song,
    sections: song.sections.map((s) => (s.id === id ? updater(s) : s)),
  };
}
