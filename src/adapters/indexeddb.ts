import { createStore, get, set, del, delMany, keys } from "idb-keyval";
import { Song, safeParseSong, type SongSummary, summarize } from "../schema/song.js";
import { Deck, safeParseDeck, summarizeDeck, type DeckSummary } from "../schema/deck.js";
import { LibraryError, type AudioHandle, type LibraryAdapter } from "./types.js";
import { assertRelativeSegments } from "./paths.js";

/**
 * IndexedDB-backed implementation — the fallback for every browser that
 * isn't Chromium. `BrowserLibraryAdapter` needs the File System Access API
 * (Chrome/Edge/Brave only); IndexedDB is supported everywhere, including
 * Firefox and Safari, so this is what makes "every browser" true.
 *
 * Trade-off, and it's a real one: the library lives inside the browser's own
 * storage, not as files in a folder. There is nothing to point Finder or
 * Explorer at, nothing to back up by copying a directory, and clearing site
 * data deletes it. `BrowserLibraryAdapter` is strictly better when it's
 * available; this exists so the app isn't Chromium-only.
 *
 * Three separate single-store databases rather than one multi-store database:
 * idb-keyval's `createStore(dbName, storeName)` only creates `storeName`
 * during that database's *first* open (the IndexedDB upgrade transaction) —
 * a second `createStore` call against the same `dbName` with a different
 * store name will not add it. Giving each store its own database sidesteps
 * that entirely rather than hand-rolling upgrade logic for one shared file.
 */

const songsStore = createStore("libre-off-songs", "songs");
const filesStore = createStore("libre-off-files", "files"); // key: `${songId}/${relPath}` -> Blob
const peaksStore = createStore("libre-off-peaks", "peaks"); // key: songId -> number[][]
const decksStore = createStore("libre-off-decks", "decks"); // key: deckId -> Deck
const deckFilesStore = createStore("libre-off-deck-files", "files"); // key: `${deckId}/${relPath}` -> Blob

function fileKey(ownerId: string, relPath: string): string {
  return `${ownerId}/${assertRelativeSegments(relPath).join("/")}`;
}

function notFound(what: string, cause?: unknown): LibraryError {
  return new LibraryError("not-found", `${what} not found`, cause);
}

export function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export class IndexedDbLibraryAdapter implements LibraryAdapter {
  readonly kind = "indexeddb" as const;

  #attached = false;

  isAttached(): boolean {
    return this.#attached;
  }

  /**
   * There's no folder to pick and nothing to prompt for — IndexedDB is
   * already scoped to the origin. This just flips the "attached" flag the
   * UI gates on, and best-effort asks the browser not to evict the data
   * under storage pressure (Safari in particular is aggressive about this).
   */
  async attach(): Promise<boolean> {
    if (!isIndexedDbSupported()) {
      throw new LibraryError("not-supported", "This browser has no IndexedDB.");
    }
    await navigator.storage?.persist?.().catch(() => false);
    this.#attached = true;
    return true;
  }

  async restore(): Promise<boolean> {
    if (!isIndexedDbSupported()) return false;
    this.#attached = true;
    return true;
  }

  async detach(): Promise<void> {
    // Detaching just stops using the store for this session — it does not
    // delete anything, same contract as BrowserLibraryAdapter losing its
    // folder handle. The data is still there next time attach() is called.
    this.#attached = false;
  }

  // ── songs ────────────────────────────────────────────────────────────────

  async listSongs(): Promise<SongSummary[]> {
    const ids = await keys<string>(songsStore);
    const out: SongSummary[] = [];
    for (const id of ids) {
      try {
        out.push(summarize(await this.readSong(id)));
      } catch (err) {
        console.warn(`[library] skipping "${id}":`, err);
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  async readSong(id: string): Promise<Song> {
    const raw = await get(id, songsStore);
    if (raw === undefined) throw notFound(`song "${id}"`);
    // Runs every loaded song through migrateSong() first (hard rule #6) —
    // an old record must keep loading, not just newly-written ones.
    const parsed = safeParseSong(raw);
    if (!parsed.success) {
      throw new LibraryError("invalid-song", `song "${id}" failed validation`, parsed.error);
    }
    return parsed.data;
  }

  async writeSong(song: Song): Promise<Song> {
    const validated = Song.parse({ ...song, updatedAt: new Date().toISOString() });
    await set(validated.id, validated, songsStore);
    return validated;
  }

  async deleteSong(id: string): Promise<void> {
    await del(id, songsStore);
    const fileKeys = await keys<string>(filesStore);
    await delMany(
      fileKeys.filter((k) => k === id || k.startsWith(`${id}/`)),
      filesStore,
    );
    await del(id, peaksStore);
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
    const blob = await get<Blob>(fileKey(song.id, audio.path), filesStore);
    if (!blob) throw notFound(`audio for song "${song.id}"`);
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  async readAsset(songId: string, relPath: string): Promise<Blob> {
    const blob = await get<Blob>(fileKey(songId, relPath), filesStore);
    if (!blob) throw notFound(`asset "${relPath}"`);
    return blob;
  }

  async writeAsset(songId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void> {
    const blob = data instanceof Blob ? data : new Blob([data]);
    await set(fileKey(songId, relPath), blob, filesStore);
  }

  // ── decks ────────────────────────────────────────────────────────────────

  async listDecks(): Promise<DeckSummary[]> {
    const ids = await keys<string>(decksStore);
    const out: DeckSummary[] = [];
    for (const id of ids) {
      try {
        out.push(summarizeDeck(await this.readDeck(id)));
      } catch (err) {
        console.warn(`[library] skipping deck "${id}":`, err);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readDeck(id: string): Promise<Deck> {
    const raw = await get(id, decksStore);
    if (raw === undefined) throw notFound(`deck "${id}"`);
    const parsed = safeParseDeck(raw);
    if (!parsed.success) {
      throw new LibraryError("invalid-song", `deck "${id}" failed validation`, parsed.error);
    }
    return parsed.data;
  }

  async writeDeck(deck: Deck): Promise<Deck> {
    const validated = Deck.parse({ ...deck, updatedAt: new Date().toISOString() });
    await set(validated.id, validated, decksStore);
    return validated;
  }

  async deleteDeck(id: string): Promise<void> {
    await del(id, decksStore);
    const fileKeys = await keys<string>(deckFilesStore);
    await delMany(
      fileKeys.filter((k) => k === id || k.startsWith(`${id}/`)),
      deckFilesStore,
    );
  }

  async readDeckAsset(deckId: string, relPath: string): Promise<Blob> {
    const blob = await get<Blob>(fileKey(deckId, relPath), deckFilesStore);
    if (!blob) throw notFound(`deck asset "${relPath}"`);
    return blob;
  }

  async writeDeckAsset(deckId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void> {
    const blob = data instanceof Blob ? data : new Blob([data]);
    await set(fileKey(deckId, relPath), blob, deckFilesStore);
  }

  async resolveDeckMedia(deckId: string, relPath: string): Promise<AudioHandle> {
    const blob = await this.readDeckAsset(deckId, relPath);
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  // ── peaks cache ──────────────────────────────────────────────────────────

  async readPeaks(song: Song): Promise<number[][] | null> {
    const peaks = await get<number[][]>(song.id, peaksStore);
    return peaks ?? null;
  }

  async writePeaks(song: Song, peaks: number[][]): Promise<void> {
    await set(song.id, peaks, peaksStore);
  }
}
