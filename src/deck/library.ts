import type { DeckSummary } from "../schema/deck.js";

export type LibraryView = "list" | "grid";

export function filterDecks(decks: DeckSummary[], query: string): DeckSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? decks.filter((deck) => deck.title.toLocaleLowerCase().includes(needle)) : decks;
}

export function newestFirst(decks: DeckSummary[]): DeckSummary[] {
  return [...decks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * A decorative waveform's bar heights, each 0–1, seeded so a deck looks the same on every load and unlike its neighbours.
 * It is not the song: decoding every deck's audio for an ornament was rejected, so nothing built on this may label it
 * with a time or duration.
 */
export function waveformBars(seed: string, count: number): number[] {
  let hash = 0x811c9dc5;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  const next = () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let mixed = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const phase = next() * Math.PI * 2;
  const swells = 2 + next() * 3;
  return Array.from({ length: count }, (_, i) => {
    const swell = 0.62 + 0.38 * Math.sin((i / count) * Math.PI * swells + phase);
    return Math.round(Math.max(0.12, swell * (0.3 + 0.7 * next())) * 1000) / 1000;
  });
}
