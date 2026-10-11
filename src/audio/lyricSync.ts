/**
 * Finds where each song section starts by looking for its lyrics in a
 * timestamped transcript of the recording.
 *
 * Plain text matching, run in the browser: the chart's lyrics never leave the
 * machine. A transcript of singing is imperfect (misheard words, merged or
 * split phrases), so matching is fuzzy and only has to be right about *which
 * phrase* a section begins at.
 */

export interface Phrase { start: number; end: number; text: string }
export interface SectionMatch { start: number; end: number }

/** A section whose lyrics have fewer words than this is too short to match reliably. */
const MIN_TOKENS = 3;
/** How many of a section's opening words are searched for. */
const HEAD_TOKENS = 24;
/** Minimum share of those words that must appear, in order, for a match to count. */
const THRESHOLD = 0.35;
const MAX_WINDOW_PHRASES = 4;
/** How many closing words are searched for to find where a section stops. */
const TAIL_TOKENS = 10;

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Equal, or one edit apart for words long enough that one edit is a mishearing, not a different word. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/** Longest common subsequence length, treating near-identical words as equal. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = sameWord(a[i - 1]!, b[j - 1]!) ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * How well the transcript, starting at phrase `s`, matches the section's
 * opening words. Also returns the last phrase the window covered.
 */
function scoreAt(head: readonly string[], phrases: readonly string[][], s: number): { score: number; last: number } {
  const window: string[] = [];
  let last = s;
  for (let p = s; p < Math.min(phrases.length, s + MAX_WINDOW_PHRASES); p++) {
    window.push(...phrases[p]!);
    last = p;
    if (window.length >= head.length * 1.3) break;
  }
  const score = lcs(head, window) / head.length;
  // The window must actually begin the section: its first phrase has to be made
  // mostly of the section's opening words. Otherwise this is an earlier phrase
  // whose window merely runs into the section, and the real start is later.
  const first = phrases[s]!;
  const leads = first.length > 0 && lcs(head.slice(0, first.length + 2), first) / first.length >= 0.5;
  return { score: leads ? score : score * 0.7, last };
}

/**
 * One entry per section: where it starts and ends in the recording, or null
 * when it has no lyrics or couldn't be found. Sections are matched in order,
 * so a repeated chorus is found at its own position, not the first one's.
 */
export function alignLyrics(phrases: readonly Phrase[], sections: ReadonlyArray<{ lyrics?: string[] }>): Array<SectionMatch | null> {
  const out: Array<SectionMatch | null> = sections.map(() => null);
  const spoken = phrases.map((p) => tokenize(p.text));
  const heads = sections.map((s) => tokenize((s.lyrics ?? []).join(" ")).slice(0, HEAD_TOKENS));
  const ks = heads.flatMap((h, i) => (h.length >= MIN_TOKENS ? [i] : []));
  const S = phrases.length;
  if (ks.length === 0 || S === 0) return out;

  // sc[k][s]: section ks[k] against the transcript from phrase s (0 when below threshold).
  const sc = ks.map((i) => Array.from({ length: S }, (_, s) => {
    const { score, last } = scoreAt(heads[i]!, spoken, s);
    return { score: score >= THRESHOLD ? score : 0, last };
  }));

  // best[k][s]: highest total for the first k sections using only phrases before s.
  const best = Array.from({ length: ks.length + 1 }, () => new Array<number>(S + 1).fill(0));
  const choice = Array.from({ length: ks.length + 1 }, () => new Array<0 | 1 | 2>(S + 1).fill(0));
  for (let k = 1; k <= ks.length; k++) {
    for (let s = 0; s <= S; s++) {
      let value = best[k - 1]![s]!; // leave this section unmatched
      let pick: 0 | 1 | 2 = 1;
      if (s > 0) {
        if (best[k]![s - 1]! > value) { value = best[k]![s - 1]!; pick = 0; } // move on one phrase
        const m = sc[k - 1]![s - 1]!.score;
        if (m > 0 && best[k - 1]![s - 1]! + m > value) { value = best[k - 1]![s - 1]! + m; pick = 2; } // match at phrase s-1
      }
      best[k]![s] = value;
      choice[k]![s] = pick;
    }
  }

  const starts = new Map<number, number>(); // section index -> phrase index it begins at
  for (let k = ks.length, s = S; k > 0 && s >= 0;) {
    const pick = choice[k]![s]!;
    if (pick === 2) {
      starts.set(ks[k - 1]!, s - 1);
      out[ks[k - 1]!] = { start: phrases[s - 1]!.start, end: phrases[sc[k - 1]![s - 1]!.last]!.end };
      k--; s--;
    } else if (pick === 1) k--;
    else s--;
  }

  // Where the singing of each matched section stops: the last phrase before the
  // next matched section that contains the section's closing words. Instrumental
  // sections that follow start there.
  const order = [...starts.entries()].sort((a, b) => a[1] - b[1]);
  order.forEach(([section, first], idx) => {
    const limit = order[idx + 1]?.[1] ?? S;
    const tail = tokenize((sections[section]!.lyrics ?? []).join(" ")).slice(-TAIL_TOKENS);
    // Without a better answer the start-window's end is used, but never past the next section.
    const capped = Math.min(out[section]!.end, limit < S ? phrases[limit]!.start : Infinity);
    out[section] = { start: out[section]!.start, end: Math.max(out[section]!.start, capped) };
    for (let p = limit - 1; p >= first; p--) {
      // The last phrase that is mostly made of the section's closing words.
      const said = spoken[p]!;
      if (said.length > 0 && lcs(tail.slice(-Math.max(3, said.length + 2)), said) / Math.min(said.length, tail.length) >= 0.5) {
        out[section] = { start: out[section]!.start, end: phrases[p]!.end };
        break;
      }
    }
  });
  return out;
}
