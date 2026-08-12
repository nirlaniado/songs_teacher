import type { Deck, Slide } from "../schema/deck.js";
import type { Target } from "./ops.js";

/**
 * Turns a `Target` into concrete slide indexes.
 *
 * Every op targets slides through this one function, so "which slides did it
 * mean?" is written and tested once rather than re-derived per op.
 */

/** Normalized for comparison: lowercase, punctuation and spacing collapsed. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does `slide` belong to the family named `base`? Compares against the name
 * with any trailing number stripped, so "Verse 2" matches base "verse" but
 * "Reverse" does not — matching is on whole words, not substrings, because
 * substring matching would make "chorus" also match "pre-chorus".
 */
function matchesBase(slide: Slide, base: string): boolean {
  const family = norm(slide.name).replace(/\s*\d+\s*$/, "");
  return family === norm(base);
}

export function resolveTarget(deck: Deck, target: Target, currentSlide = 0): number[] {
  switch (target.by) {
    case "all":
      return deck.slides.map((_, i) => i);

    case "current":
      return deck.slides[currentSlide] ? [currentSlide] : [];

    case "index":
      // Silently drop out-of-range indexes rather than throwing: a batch that
      // targets five slides shouldn't fail wholesale because one drifted.
      return [...new Set(target.indexes)].filter((i) => i < deck.slides.length).sort((a, b) => a - b);

    case "name": {
      const needle = norm(target.pattern);
      return deck.slides
        .map((slide, i) => ({ slide, i }))
        .filter(({ slide }) => norm(slide.name).includes(needle))
        .map(({ i }) => i);
    }

    case "family":
      return deck.slides
        .map((slide, i) => ({ slide, i }))
        .filter(({ slide }) => matchesBase(slide, target.base))
        .map(({ i }) => i);

    case "nameOrdinal": {
      // Ordinals count only slides in the family, so "verses 1 2 3" picks the
      // 1st/2nd/3rd verse regardless of the choruses sitting between them.
      const family = deck.slides
        .map((slide, i) => ({ slide, i }))
        .filter(({ slide }) => matchesBase(slide, target.base));
      return [...new Set(target.ordinals)]
        .sort((a, b) => a - b)
        .map((n) => family[n - 1]?.i)
        .filter((i): i is number => i !== undefined);
    }
  }
}

/** Slide names for a resolved target, for preview text like "Verse 1, Verse 2". */
export function namesOf(deck: Deck, indexes: readonly number[]): string[] {
  return indexes.map((i) => deck.slides[i]?.name ?? `Slide ${i + 1}`);
}
