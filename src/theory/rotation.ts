/**
 * Canonical rotation via Booth's algorithm — the lexicographically smallest
 * rotation of a cyclic sequence, comparing elements through `key`.
 *
 * Per hard rule #4, this is derived data, never stored: two progressions
 * sharing a canonical rotation share a harmonic loop, but they are not
 * therefore identical — the starting chord carries harmonic function and
 * feel (I-V-vi-IV feels different from vi-IV-I-V). Store the original
 * verbatim; compare canonical rotations only to detect the "same loop,
 * different entry point" relationship (edge type 3, "Same Harmonic Loop").
 */
export function canonicalRotation<T>(sequence: readonly T[], key: (t: T) => string): T[] {
  const n = sequence.length;
  if (n === 0) return [];
  if (n === 1) return [sequence[0]!];

  const doubled = [...sequence, ...sequence];
  const keys = doubled.map(key);
  const failure: number[] = new Array(2 * n).fill(-1);
  let k = 0; // start index of the least rotation found so far

  for (let j = 1; j < 2 * n; j++) {
    const sj = keys[j]!;
    let i = failure[j - k - 1]!;
    while (i !== -1 && sj !== keys[k + i + 1]!) {
      if (sj < keys[k + i + 1]!) k = j - i - 1;
      i = failure[i]!;
    }
    if (sj !== keys[k + i + 1]!) {
      if (sj < keys[k]!) k = j;
      failure[j - k] = -1;
    } else {
      failure[j - k] = i + 1;
    }
  }
  return [...sequence.slice(k), ...sequence.slice(0, k)];
}

/** True canonical-rotation match: same multiset *and* cyclic order, at any starting point. */
export function sameCanonicalRotation<T>(
  a: readonly T[],
  b: readonly T[],
  key: (t: T) => string,
): boolean {
  if (a.length !== b.length) return false;
  const ca = canonicalRotation(a, key).map(key);
  const cb = canonicalRotation(b, key).map(key);
  return ca.length === cb.length && ca.every((v, i) => v === cb[i]);
}
