/**
 * Song-section vocabulary.
 *
 * This is the one place with any domain knowledge, and it is purely
 * *lexical*: it maps the words people type to canonical slide names. It
 * knows nothing about music — it does not know what a chorus sounds like,
 * only that "hook" and "chorus" name the same slide.
 */

export interface SectionWord {
  /** Canonical display name used for the slide title. */
  canonical: string;
  /** Everything a user might type for it, normalized (lowercase, no punctuation). */
  aliases: string[];
}

export const SECTION_WORDS: SectionWord[] = [
  { canonical: "Intro", aliases: ["intro", "introduction", "opening"] },
  // Longer names first matters: "pre chorus" must win over "chorus", and the
  // matcher below scans longest-alias-first for exactly that reason.
  { canonical: "Pre-Chorus", aliases: ["pre chorus", "prechorus", "pre hook", "prehook", "pre"] },
  { canonical: "Post-Chorus", aliases: ["post chorus", "postchorus"] },
  { canonical: "Chorus", aliases: ["chorus", "hook", "refrain"] },
  { canonical: "Verse", aliases: ["verse"] },
  { canonical: "Bridge", aliases: ["bridge", "middle eight", "middle 8"] },
  { canonical: "Solo", aliases: ["solo", "guitar solo", "lead"] },
  { canonical: "Instrumental", aliases: ["instrumental", "interlude", "break"] },
  { canonical: "Breakdown", aliases: ["breakdown", "drop"] },
  { canonical: "Outro", aliases: ["outro", "ending", "coda", "tag"] },
  { canonical: "Vamp", aliases: ["vamp"] },
];

/** Aliases longest-first, so multi-word names match before their own suffixes. */
const ALIASES: Array<{ alias: string; canonical: string }> = SECTION_WORDS.flatMap((w) =>
  w.aliases.map((alias) => ({ alias, canonical: w.canonical })),
).sort((a, b) => b.alias.length - a.alias.length);

export function normalizeWords(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface ParsedSection {
  canonical: string;
  /** Explicit number the user typed ("verse2" -> 2), if any. */
  number?: number;
}

/**
 * Reads a run of section words: "intro verse1 pre hook chorus verse2 bridge".
 * Returns null if the text contains anything that isn't a section word or a
 * number, so an unrelated sentence is never mistaken for a structure list.
 */
export function parseSectionRun(text: string): ParsedSection[] | null {
  const words = normalizeWords(text);
  if (words === "") return null;

  const out: ParsedSection[] = [];
  let rest = words;

  while (rest.length > 0) {
    // Filler that can appear between section names without changing meaning.
    const skipped = rest.match(/^(?:then|and|a|an|the|slide|slides|,)\s*/);
    if (skipped) {
      rest = rest.slice(skipped[0].length);
      continue;
    }

    // An alias matches only at a word boundary: end of input, a space, or a
    // digit ("verse2"). Without the boundary check, "versatile" would match
    // the alias "verse" and be read as a section.
    const match = ALIASES.find(({ alias }) => {
      if (!rest.startsWith(alias)) return false;
      const after = rest.slice(alias.length);
      return after === "" || after.startsWith(" ") || /^\d/.test(after);
    });
    if (!match) return null;

    rest = rest.slice(match.alias.length).trimStart();

    // An immediately following number belongs to this section ("verse 2").
    const num = rest.match(/^(\d+)\s*/);
    if (num) {
      out.push({ canonical: match.canonical, number: Number(num[1]) });
      rest = rest.slice(num[0].length);
    } else {
      out.push({ canonical: match.canonical });
    }
  }

  return out.length > 0 ? out : null;
}

/**
 * Turns parsed sections into final slide titles.
 *
 * A name the user numbered keeps that number. A name that appears more than
 * once *without* numbers gets auto-numbered, because two slides both called
 * "Chorus" are indistinguishable in the slide rail and impossible to target
 * individually afterwards. A name appearing once stays bare.
 */
export function titlesFor(sections: readonly ParsedSection[]): string[] {
  const totals = new Map<string, number>();
  for (const s of sections) totals.set(s.canonical, (totals.get(s.canonical) ?? 0) + 1);

  const seen = new Map<string, number>();
  return sections.map((s) => {
    const n = (seen.get(s.canonical) ?? 0) + 1;
    seen.set(s.canonical, n);
    if (s.number !== undefined) return `${s.canonical} ${s.number}`;
    if ((totals.get(s.canonical) ?? 0) > 1) return `${s.canonical} ${n}`;
    return s.canonical;
  });
}

/**
 * The canonical family name a target word refers to ("verses" -> "Verse").
 * Tries the word as typed, then the two common plural forms — "choruses"
 * needs "es" stripped, not just "s".
 */
export function canonicalFor(word: string): string | null {
  const normalized = normalizeWords(word);
  const candidates = [normalized, normalized.replace(/es$/, ""), normalized.replace(/s$/, "")];
  for (const candidate of candidates) {
    const hit = ALIASES.find(({ alias }) => alias === candidate);
    if (hit) return hit.canonical;
  }
  return null;
}
