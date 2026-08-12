import { createStore, get, set, del } from "idb-keyval";
import { Song, safeParseSong, type SongSummary, summarize } from "../schema/song.js";
import { Deck, safeParseDeck, summarizeDeck, type DeckSummary } from "../schema/deck.js";
import {
  LAYOUT,
  LibraryError,
  type AudioHandle,
  type LibraryAdapter,
} from "./types.js";
import { assertRelativeSegments } from "./paths.js";

/**
 * File System Access API implementation.
 *
 * Chromium only — Firefox and Safari have no directory picker. That is an
 * accepted V1 limitation: this adapter exists so the app runs in a browser tab
 * with real HMR during development, and so the vertical slice is shippable
 * before Electron is wired up. The Electron adapter is the one users get.
 *
 * Consequence of the sandbox: audio must live inside the chosen library root.
 * An absolute `song.audio.path` is unreachable here and is rejected rather than
 * silently failing at playback time.
 */

const handleStore = createStore("libre-off", "handles");
const ROOT_KEY = "library-root";

type PermissionDescriptor = { mode?: "read" | "readwrite" };
type PermissionCapable = {
  queryPermission?(d?: PermissionDescriptor): Promise<PermissionState>;
  requestPermission?(d?: PermissionDescriptor): Promise<PermissionState>;
};

type DirectoryPicker = (options?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export function isBrowserLibrarySupported(): boolean {
  return typeof directoryPicker() === "function";
}

/** Ask for readwrite, prompting only if we do not already hold it. */
async function ensurePermission(handle: FileSystemDirectoryHandle, prompt: boolean): Promise<boolean> {
  const h = handle as unknown as PermissionCapable;
  const opts: PermissionDescriptor = { mode: "readwrite" };
  if (typeof h.queryPermission === "function" && (await h.queryPermission(opts)) === "granted") {
    return true;
  }
  if (!prompt || typeof h.requestPermission !== "function") return false;
  return (await h.requestPermission(opts)) === "granted";
}

const segments = assertRelativeSegments;

function notFound(what: string, cause?: unknown): LibraryError {
  return new LibraryError("not-found", `${what} not found`, cause);
}

export class BrowserLibraryAdapter implements LibraryAdapter {
  readonly kind = "browser" as const;

  #root: FileSystemDirectoryHandle | null = null;

  isAttached(): boolean {
    return this.#root !== null;
  }

  async attach(): Promise<boolean> {
    const pick = directoryPicker();
    if (!pick) {
      throw new LibraryError(
        "not-supported",
        "This browser has no directory picker. Use Chrome or Edge, or run the desktop build.",
      );
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pick({ id: "libre-off-library", mode: "readwrite" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false;
      throw new LibraryError("io", "could not open the library folder", err);
    }
    if (!(await ensurePermission(handle, true))) {
      throw new LibraryError("permission-denied", "write access to the library folder was declined");
    }
    this.#root = handle;
    await set(ROOT_KEY, handle, handleStore);
    return true;
  }

  /**
   * Chromium persists directory handles across sessions but drops the grant, so
   * this succeeds only when permission happens to still be live. When it returns
   * false the UI must route the user through `attach()` from a real click —
   * calling it on load will throw.
   */
  async restore(): Promise<boolean> {
    if (this.#root) return true;
    const handle = await get<FileSystemDirectoryHandle>(ROOT_KEY, handleStore);
    if (!handle) return false;
    if (!(await ensurePermission(handle, false))) return false;
    this.#root = handle;
    return true;
  }

  async detach(): Promise<void> {
    this.#root = null;
    await del(ROOT_KEY, handleStore);
  }

  // ── songs ────────────────────────────────────────────────────────────────

  /**
   * Reads and validates every song.json. Fine at V1 scale (a local read is
   * sub-millisecond); when the library outgrows it, this is what the SQLite
   * index replaces — the signature does not change.
   */
  async listSongs(): Promise<SongSummary[]> {
    const songsDir = await this.#dir([LAYOUT.songsDir], { create: true });
    const out: SongSummary[] = [];
    for await (const entry of songsDir.values()) {
      if (entry.kind !== "directory") continue;
      try {
        out.push(summarize(await this.readSong(entry.name)));
      } catch (err) {
        // One malformed song must not blank the whole library view.
        console.warn(`[library] skipping "${entry.name}":`, err);
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  async readSong(id: string): Promise<Song> {
    const file = await this.#file([LAYOUT.songsDir, id, LAYOUT.songFile], { create: false });
    const text = await (await file.getFile()).text();

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new LibraryError("invalid-song", `${id}/${LAYOUT.songFile} is not valid JSON`, err);
    }

    // Runs every loaded song through migrateSong() first (hard rule #6) —
    // an old song.json on disk must keep loading, not just newly-written ones.
    const parsed = safeParseSong(raw);
    if (!parsed.success) {
      throw new LibraryError("invalid-song", `${id}/${LAYOUT.songFile} failed validation`, parsed.error);
    }
    return parsed.data;
  }

  async writeSong(song: Song): Promise<Song> {
    const validated = Song.parse({ ...song, updatedAt: new Date().toISOString() });
    const file = await this.#file([LAYOUT.songsDir, validated.id, LAYOUT.songFile], { create: true });
    await this.#writeFile(file, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }

  async deleteSong(id: string): Promise<void> {
    const songsDir = await this.#dir([LAYOUT.songsDir], { create: true });
    try {
      await songsDir.removeEntry(id, { recursive: true });
    } catch (err) {
      throw notFound(`song "${id}"`, err);
    }
  }

  // ── binaries ─────────────────────────────────────────────────────────────

  async resolveAudio(song: Song): Promise<AudioHandle> {
    const audio = song.audio;
    if (!audio) {
      throw new LibraryError(
        "not-found",
        `song "${song.id}" has no audio file — callers should check \`song.audio\` first.`,
      );
    }
    const file = await this.#file(
      [LAYOUT.songsDir, song.id, ...segments(audio.path)],
      { create: false },
    );
    const url = URL.createObjectURL(await file.getFile());
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  async readAsset(songId: string, relPath: string): Promise<Blob> {
    const file = await this.#file([LAYOUT.songsDir, songId, ...segments(relPath)], { create: false });
    return file.getFile();
  }

  async writeAsset(songId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void> {
    const file = await this.#file([LAYOUT.songsDir, songId, ...segments(relPath)], { create: true });
    await this.#writeFile(file, data);
  }

  // ── decks ────────────────────────────────────────────────────────────────

  async listDecks(): Promise<DeckSummary[]> {
    const decksDir = await this.#dir([LAYOUT.decksDir], { create: true });
    const out: DeckSummary[] = [];
    for await (const entry of decksDir.values()) {
      if (entry.kind !== "directory") continue;
      try {
        out.push(summarizeDeck(await this.readDeck(entry.name)));
      } catch (err) {
        console.warn(`[library] skipping deck "${entry.name}":`, err);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readDeck(id: string): Promise<Deck> {
    const file = await this.#file([LAYOUT.decksDir, id, LAYOUT.deckFile], { create: false });
    const text = await (await file.getFile()).text();

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new LibraryError("invalid-song", `${id}/${LAYOUT.deckFile} is not valid JSON`, err);
    }

    const parsed = safeParseDeck(raw);
    if (!parsed.success) {
      throw new LibraryError("invalid-song", `${id}/${LAYOUT.deckFile} failed validation`, parsed.error);
    }
    return parsed.data;
  }

  async writeDeck(deck: Deck): Promise<Deck> {
    const validated = Deck.parse({ ...deck, updatedAt: new Date().toISOString() });
    const file = await this.#file([LAYOUT.decksDir, validated.id, LAYOUT.deckFile], { create: true });
    await this.#writeFile(file, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }

  async deleteDeck(id: string): Promise<void> {
    const decksDir = await this.#dir([LAYOUT.decksDir], { create: true });
    try {
      await decksDir.removeEntry(id, { recursive: true });
    } catch (err) {
      throw notFound(`deck "${id}"`, err);
    }
  }

  async readDeckAsset(deckId: string, relPath: string): Promise<Blob> {
    const file = await this.#file([LAYOUT.decksDir, deckId, ...segments(relPath)], { create: false });
    return file.getFile();
  }

  async writeDeckAsset(deckId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void> {
    const file = await this.#file([LAYOUT.decksDir, deckId, ...segments(relPath)], { create: true });
    await this.#writeFile(file, data);
  }

  async resolveDeckMedia(deckId: string, relPath: string): Promise<AudioHandle> {
    const blob = await this.readDeckAsset(deckId, relPath);
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  // ── peaks cache ──────────────────────────────────────────────────────────

  async readPeaks(song: Song): Promise<number[][] | null> {
    try {
      const file = await this.#file(
        [LAYOUT.songsDir, song.id, LAYOUT.cacheDir, LAYOUT.peaksFile],
        { create: false },
      );
      return JSON.parse(await (await file.getFile()).text()) as number[][];
    } catch {
      return null; // no cache is normal, not an error
    }
  }

  async writePeaks(song: Song, peaks: number[][]): Promise<void> {
    const file = await this.#file(
      [LAYOUT.songsDir, song.id, LAYOUT.cacheDir, LAYOUT.peaksFile],
      { create: true },
    );
    await this.#writeFile(file, JSON.stringify(peaks));
  }

  // ── internals ────────────────────────────────────────────────────────────

  #requireRoot(): FileSystemDirectoryHandle {
    if (!this.#root) {
      throw new LibraryError("not-attached", "no library folder is open — call attach() first");
    }
    return this.#root;
  }

  async #dir(path: string[], opts: { create: boolean }): Promise<FileSystemDirectoryHandle> {
    let dir = this.#requireRoot();
    for (const name of path) {
      try {
        dir = await dir.getDirectoryHandle(name, { create: opts.create });
      } catch (err) {
        throw notFound(`folder "${path.join("/")}"`, err);
      }
    }
    return dir;
  }

  async #file(path: string[], opts: { create: boolean }): Promise<FileSystemFileHandle> {
    const name = path.at(-1);
    if (name === undefined) throw new LibraryError("io", "empty path");
    const dir = await this.#dir(path.slice(0, -1), opts);
    try {
      return await dir.getFileHandle(name, { create: opts.create });
    } catch (err) {
      throw notFound(`file "${path.join("/")}"`, err);
    }
  }

  async #writeFile(handle: FileSystemFileHandle, data: string | Blob | ArrayBuffer): Promise<void> {
    const stream = await handle.createWritable();
    try {
      await stream.write(data);
    } finally {
      await stream.close();
    }
  }
}
