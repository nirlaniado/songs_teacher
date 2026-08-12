import type { DeckPlayer } from "./types.js";

/**
 * Single-track playback through an `<audio>` element.
 *
 * The path decks take when they have no stems — which is most of them. It
 * decodes nothing up front and holds no buffers, so a deck that has never been
 * separated costs exactly what it did before stems existed.
 */
export function createElementPlayer(url: string): DeckPlayer {
  const el = new Audio(url);
  el.preload = "auto";

  return {
    ready() {
      if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          el.removeEventListener("loadedmetadata", done);
          el.removeEventListener("error", done);
          resolve();
        };
        el.addEventListener("loadedmetadata", done);
        // Resolve on error too: a broken file should surface as "no duration",
        // not as a promise that never settles and freezes the caller.
        el.addEventListener("error", done);
      });
    },
    play: () => el.play(),
    pause: () => el.pause(),
    seek(seconds) {
      el.currentTime = Math.max(0, seconds);
    },
    currentTime: () => el.currentTime,
    duration: () => (Number.isFinite(el.duration) ? el.duration : 0),
    isPlaying: () => !el.paused && !el.ended,
    setGains() {
      // Nothing to mix — a single track has no stems to balance.
    },
    dispose() {
      el.pause();
      el.removeAttribute("src");
      el.load();
    },
  };
}
