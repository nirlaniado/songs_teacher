/**
 * CTC forced alignment: given known lyrics and a wav2vec2 emission matrix,
 * find when each character is sung.
 *
 * Pure and in frame units, for the same reason `deck/geometry.ts` stays in
 * slide units: an aligner that is one frame off produces cue times that look
 * plausible and are wrong. Converting to seconds (frame * 0.02 for
 * wav2vec2-base-960h) is the caller's job.
 */

/** Output vocabulary of `wav2vec2-base-960h`, indexed by token id. `<pad>` (0) is the CTC blank, `|` (4) the word delimiter. */
export const VOCAB = [
  "<pad>", "<s>", "</s>", "<unk>", "|",
  "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M", "W", "C", "F", "G", "Y", "P", "B", "V", "K", "'", "X", "J", "Q", "Z",
] as const;

export interface TokenSpan {
  tokenIndex: number;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  /** Mean probability of the token over its frames, 0..1. */
  score: number;
}

export interface WordSpan {
  text: string;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
}

const UNITS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
  "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];

function spell(n: number): string {
  if (n < 20) return UNITS[n]!;
  return TENS[Math.floor(n / 10)]! + (n % 10 ? " " + UNITS[n % 10] : "");
}

/** Lyric text → the character tokens the model can emit, with `|` between words. */
export function normalizeForVocab(text: string): string[] {
  const words = text
    // Standalone integers 0–99 are spelled out because they are sung as words; any other digit is dropped, never mapped to <unk>, which the model never predicts.
    .replace(/\b\d+\b/g, d => (d.length <= 2 ? ` ${spell(Number(d))} ` : " "))
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’ʼ]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z'\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 0);
  return words.flatMap((w, i) => (i === 0 ? [...w] : ["|", ...w]));
}

/**
 * Viterbi path through the CTC trellis. `logProbs` is one row per frame
 * (log-probabilities or raw logits; each row is log-softmaxed here, which is a
 * no-op on rows that already are). An empty target aligns to nothing and
 * returns []; a target that cannot fit in the frames throws.
 */
export function forcedAlign(logProbs: ArrayLike<number>[], tokenIds: number[], blankId: number): TokenSpan[] {
  const n = tokenIds.length;
  if (n === 0) return [];
  if (tokenIds.includes(blankId)) throw new Error("ctcAlign: the target contains the blank token");
  const T = logProbs.length;
  let repeats = 0;
  for (let i = 1; i < n; i++) if (tokenIds[i] === tokenIds[i - 1]) repeats++;
  if (T < n + repeats) throw new Error(`ctcAlign: ${n} tokens need at least ${n + repeats} frames, got ${T}`);

  const norm = logProbs.map(logSumExp);
  const lp = (t: number, id: number) => logProbs[t]![id]! - norm[t]!;

  // Extended target: blank, l1, blank, l2, …, lN, blank.
  const S = 2 * n + 1;
  const ext = new Int32Array(S).fill(blankId);
  for (let i = 0; i < n; i++) ext[2 * i + 1] = tokenIds[i]!;

  let prev = new Float64Array(S).fill(-Infinity);
  let cur = new Float64Array(S);
  const back = new Uint8Array(T * S);
  prev[0] = lp(0, ext[0]!);
  prev[1] = lp(0, ext[1]!);
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < S; s++) {
      let best = prev[s]!;
      let step = 0;
      if (s >= 1 && prev[s - 1]! > best) { best = prev[s - 1]!; step = 1; }
      // Skipping the blank between two labels is only legal when they differ: identical neighbours (the LL in HELLO) would otherwise collapse into one.
      if (s >= 2 && ext[s] !== blankId && ext[s] !== ext[s - 2] && prev[s - 2]! > best) { best = prev[s - 2]!; step = 2; }
      cur[s] = best + lp(t, ext[s]!);
      back[t * S + s] = step;
    }
    [prev, cur] = [cur, prev];
  }

  let s = prev[S - 1]! >= prev[S - 2]! ? S - 1 : S - 2;
  if (!Number.isFinite(prev[s]!)) throw new Error("ctcAlign: no alignment has non-zero probability");

  const path = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s;
    s -= back[t * S + s]!;
  }

  const spans: TokenSpan[] = [];
  for (let t = 0; t < T; t++) {
    const p = path[t]!;
    if (p % 2 === 0) continue;
    const tokenIndex = (p - 1) / 2;
    const last = spans[spans.length - 1];
    const prob = Math.exp(lp(t, ext[p]!));
    if (last?.tokenIndex === tokenIndex) { last.score += prob; last.endFrame = t + 1; }
    else spans.push({ tokenIndex, startFrame: t, endFrame: t + 1, score: prob });
  }
  for (const span of spans) span.score /= span.endFrame - span.startFrame;
  return spans;
}

/** Groups character spans into words on the `|` delimiter. */
export function spansToWords(spans: TokenSpan[], tokens: string[]): WordSpan[] {
  if (spans.length !== tokens.length) throw new Error(`ctcAlign: ${spans.length} spans for ${tokens.length} tokens`);
  const words: WordSpan[] = [];
  let open: WordSpan | null = null;
  for (const span of spans) {
    const token = tokens[span.tokenIndex]!;
    if (token === "|") { open = null; continue; }
    if (open) { open.text += token; open.endFrame = span.endFrame; }
    else { open = { text: token, startFrame: span.startFrame, endFrame: span.endFrame }; words.push(open); }
  }
  return words;
}

function logSumExp(row: ArrayLike<number>): number {
  let max = -Infinity;
  for (let i = 0; i < row.length; i++) if (row[i]! > max) max = row[i]!;
  if (max === -Infinity) return max;
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.exp(row[i]! - max);
  return max + Math.log(sum);
}
