import type { Song, SongSummary } from "../schema/song.js";
import type { Deck, DeckSummary } from "../schema/deck.js";

/**
 * The whole platform boundary.
 *
 * Everything above this line is plain browser code — React, WaveSurfer, the
 * theory engine, the graph. Nothing above it imports `fs`, `path`, `child_process`
 * or anything from Electron. That rule is what keeps `vite dev` in Chrome as the
 * daily loop and turns "wrap it in Electron" into a second implementation of this
 * file rather than a port.
 *
 * If you find yourself wanting to widen this interface to get at the filesystem,
 * that is the signal to add a method here, not to reach around it.
 */

/** On-disk layout, identical across adapters. */
export const LAYOUT = {
  songsDir: "songs",
  songFile: "song.json",
  decksDir: "decks",
  deckFile: "deck.json",
  assetsDir: "assets",
  cacheDir: ".cache",
  peaksFile: "peaks.json",
} as const;

export type AdapterKind = "browser" | "indexeddb" | "electron";

export type LibraryErrorCode =
  | "not-attached"
  | "not-supported"
  | "permission-denied"
  | "not-found"
  | "invalid-song"
  | "out-of-root"
  | "io";

export class LibraryError extends Error {
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

/**
 * A playable URL plus its cleanup. Browser object URLs leak the entire decoded
 * file until revoked, and a study session opens a lot of songs — always call
 * `release()` when swapping tracks.
 */
export interface AudioHandle {
  url: string;
  release(): void;
}

export interface LibraryAdapter {
  readonly kind: AdapterKind;

  /** Whether a library root is currently usable. */
  isAttached(): boolean;

  /**
   * Attach to a library root, prompting the user. MUST be called from a user
   * gesture in the browser — the directory picker throws otherwise.
   * Returns false if the user cancelled.
   */
  attach(): Promise<boolean>;

  /**
   * Silently re-attach to the previously used root. Returns false when the
   * stored handle is gone or its permission has lapsed, in which case the UI
   * needs to put `attach()` behind a button.
   */
  restore(): Promise<boolean>;

  detach(): Promise<void>;

  listSongs(): Promise<SongSummary[]>;
  readSong(id: string): Promise<Song>;
  /** Validates, stamps `updatedAt`, writes. Creates the song dir if needed. */
  writeSong(song: Song): Promise<Song>;
  deleteSong(id: string): Promise<void>;

  /** Resolve `song.audio.path` to something an <audio> element can play. */
  resolveAudio(song: Song): Promise<AudioHandle>;

  readAsset(songId: string, relPath: string): Promise<Blob>;
  writeAsset(songId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void>;

  // ── decks (the presentation editor) ──────────────────────────────────────
  // Stored beside songs under `decks/<deck-id>/`, same shape of API. Kept as
  // distinct methods rather than a generic document store because the two
  // document types validate against different schemas, and pushing that
  // decision down here is what lets callers stay schema-agnostic.

  listDecks(): Promise<DeckSummary[]>;
  readDeck(id: string): Promise<Deck>;
  writeDeck(deck: Deck): Promise<Deck>;
  deleteDeck(id: string): Promise<void>;

  readDeckAsset(deckId: string, relPath: string): Promise<Blob>;
  writeDeckAsset(deckId: string, relPath: string, data: Blob | ArrayBuffer): Promise<void>;
  /**
   * Object URL for a file inside a deck's folder — audio for the player,
   * images for `ImageElement`. Caller must `release()` it; a deck full of
   * images otherwise pins every decoded blob in memory for the session.
   */
  resolveDeckMedia(deckId: string, relPath: string): Promise<AudioHandle>;

  /**
   * Cached waveform peaks, so reopening a song does not re-decode the file.
   * Optional: an adapter may legitimately have no cache. Callers must handle
   * null by decoding and then calling `writePeaks`.
   */
  readPeaks?(song: Song): Promise<number[][] | null>;
  writePeaks?(song: Song, peaks: number[][]): Promise<void>;
}
