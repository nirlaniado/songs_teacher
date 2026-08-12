import type { StemId } from "../schema/deck.js";

/**
 * Per-stem mixer state.
 *
 * Session state, deliberately not part of the deck document: muting vocals to
 * run a singalong is a rehearsal setting, not a property of the presentation.
 * Storing it would dirty the deck and eat undo slots for something nobody
 * wants to undo.
 */
export interface StemState {
  id: StemId;
  muted: boolean;
  soloed: boolean;
  /** 0..1, independent of mute/solo. */
  gain: number;
}

export function initialStemState(id: StemId): StemState {
  return { id, muted: false, soloed: false, gain: 1 };
}

/**
 * Resolves mute, solo and gain into the actual output level for each stem.
 *
 * **Solo wins over mute**, the standard desk behaviour: the moment anything is
 * soloed, everything unsoloed is silent regardless of its own mute flag, and a
 * soloed stem sounds even if it was muted first. Any other rule makes "solo
 * the bass" fail confusingly when the bass happened to be muted.
 */
export function resolveGains(stems: readonly StemState[]): Record<string, number> {
  const anySoloed = stems.some((s) => s.soloed);
  const out: Record<string, number> = {};
  for (const stem of stems) {
    const audible = anySoloed ? stem.soloed : !stem.muted;
    out[stem.id] = audible ? stem.gain : 0;
  }
  return out;
}

/** True when nothing would be heard, so the UI can warn instead of looking broken. */
export function isSilent(stems: readonly StemState[]): boolean {
  return Object.values(resolveGains(stems)).every((g) => g === 0);
}

/** Toggles one flag on one stem, leaving the rest alone. */
export function toggleStem(
  stems: readonly StemState[],
  id: StemId,
  flag: "muted" | "soloed",
): StemState[] {
  return stems.map((s) => (s.id === id ? { ...s, [flag]: !s[flag] } : s));
}

export function setStemGain(
  stems: readonly StemState[],
  id: StemId,
  gain: number,
): StemState[] {
  const clamped = Math.max(0, Math.min(1, gain));
  return stems.map((s) => (s.id === id ? { ...s, gain: clamped } : s));
}

/** Clears every solo, the usual "get back to normal" action. */
export function clearSolos(stems: readonly StemState[]): StemState[] {
  return stems.map((s) => (s.soloed ? { ...s, soloed: false } : s));
}

/** Display order, so the mixer always reads the same way regardless of file order. */
const ORDER: StemId[] = ["vocals", "guitar", "piano", "other", "bass", "drums"];

export function sortStems<T extends { id: StemId }>(stems: readonly T[]): T[] {
  return [...stems].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

export const STEM_LABEL: Record<StemId, string> = {
  vocals: "Vocals",
  guitar: "Guitar",
  piano: "Piano",
  other: "Other",
  bass: "Bass",
  drums: "Drums",
};
