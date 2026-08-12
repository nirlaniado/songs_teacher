import type { StemId } from "../schema/deck.js";

/**
 * What every screen needs from playback, regardless of how many tracks are
 * actually sounding.
 *
 * `TimingPanel` and `PresentMode` used to each own an `<audio>` element and a
 * near-identical rAF clock. Stems need a different engine entirely, but
 * neither screen should learn about that, and the clock must not be written a
 * third time — so both talk to this instead.
 */
export interface DeckPlayer {
  /** Resolves once media is loaded and `duration` is meaningful. */
  ready(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  /** Seconds from the start. Safe to call while playing or paused. */
  seek(seconds: number): void;
  currentTime(): number;
  duration(): number;
  isPlaying(): boolean;
  /** Per-stem output levels, 0..1. No-op for single-track playback. */
  setGains(gains: Record<string, number>): void;
  /** Stops playback and frees decoded buffers / object URLs. */
  dispose(): void;
}

/** One decoded stem handed to the mixer. */
export interface StemSource {
  id: StemId;
  data: ArrayBuffer;
}
