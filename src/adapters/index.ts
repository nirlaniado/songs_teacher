import { BrowserLibraryAdapter, isBrowserLibrarySupported } from "./browser.js";
import { IndexedDbLibraryAdapter, isIndexedDbSupported } from "./indexeddb.js";
import type { LibraryAdapter } from "./types.js";

export * from "./types.js";
export { BrowserLibraryAdapter, isBrowserLibrarySupported } from "./browser.js";
export { IndexedDbLibraryAdapter, isIndexedDbSupported } from "./indexeddb.js";

/**
 * Picks the best adapter this browser can actually run. `BrowserLibraryAdapter`
 * (real files in a real folder) wins when the File System Access API exists —
 * Chrome, Edge, Brave. Everywhere else (Firefox, Safari) falls back to
 * `IndexedDbLibraryAdapter`, which trades "files on disk" for "works at all."
 */
export function createLibraryAdapter(): LibraryAdapter {
  return isBrowserLibrarySupported() ? new BrowserLibraryAdapter() : new IndexedDbLibraryAdapter();
}

let shared: LibraryAdapter | null = null;

/**
 * The one adapter instance the whole app shares.
 *
 * Attachment (a directory handle plus its permission grant) is per-instance
 * state, so two stores each constructing their own adapter would mean
 * attaching in one leaves the other still detached — the deck store would
 * hold an open library while the song store insisted nothing was open.
 */
export function sharedLibraryAdapter(): LibraryAdapter {
  shared ??= createLibraryAdapter();
  return shared;
}

/** True if either adapter can run here — i.e. whether the app can do anything at all. */
export function isAnyLibrarySupported(): boolean {
  return isBrowserLibrarySupported() || isIndexedDbSupported();
}
