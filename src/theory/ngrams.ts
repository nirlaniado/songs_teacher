/** Sliding-window n-grams over a sequence. Empty when the sequence is shorter than `n`. */
export function ngrams<T>(sequence: readonly T[], n: number): T[][] {
  if (n <= 0 || sequence.length < n) return [];
  const out: T[][] = [];
  for (let i = 0; i + n <= sequence.length; i++) out.push(sequence.slice(i, i + n));
  return out;
}

/**
 * Longest contiguous run shared between two sequences (classic longest-common-
 * substring DP — order-sensitive, unlike a rotation match). Used for "Partial
 * Overlap" edges: a shared n-gram of length >= `minLength` and nothing
 * stronger (identical, quality-variant, or same-loop) already matched.
 */
export function longestCommonRun<T>(
  a: readonly T[],
  b: readonly T[],
  key: (t: T) => string,
  minLength = 4,
): { length: number; ngram: T[] } | null {
  const m = a.length;
  const n = b.length;
  const ak = a.map(key);
  const bk = b.map(key);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  let bestLength = 0;
  let bestEnd = 0; // exclusive end index into `a`
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ak[i - 1] === bk[j - 1]) {
        const len = dp[i - 1]![j - 1]! + 1;
        dp[i]![j] = len;
        if (len > bestLength) {
          bestLength = len;
          bestEnd = i;
        }
      }
    }
  }
  if (bestLength < minLength) return null;
  return { length: bestLength, ngram: a.slice(bestEnd - bestLength, bestEnd) };
}
