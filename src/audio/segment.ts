import { fft } from "./fft.js";

/**
 * Finds where a song changes (intro -> verse -> chorus ...) so slides can be
 * cued to it.
 *
 * Local signal processing, same category as stem separation: nothing is
 * uploaded and nothing here understands lyrics. The pipeline is chroma
 * (12 pitch-class energies per frame) -> self-similarity -> a checkerboard
 * novelty curve whose peaks are candidate section changes, then `planCues`
 * decides which change belongs to which slide. It only ever *suggests* cues;
 * the teacher reviews them in the timing panel.
 */

const FRAME = 4096;
const HOP = 2048;
/** Frames averaged into one analysis block (~0.46 s at 22.05 kHz). */
const BLOCK_FRAMES = 5;
/** Half-width of the checkerboard kernel, in blocks (~3.7 s each side). */
const KERNEL = 8;
const MIN_HZ = 80;
const MAX_HZ = 2000;

export interface SuggestOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
}

/** Unit-length 12-bin chroma vector per hop; a silent frame stays all zeros. */
export async function chromaFrames(
  samples: Float32Array,
  rate: number,
  opts: Pick<SuggestOptions, "signal" | "onProgress"> = {},
): Promise<Float32Array[]> {
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  // Which pitch class each usable FFT bin belongs to (-1 = ignored).
  const binClass = new Int8Array(FRAME / 2).fill(-1);
  for (let k = 1; k < FRAME / 2; k++) {
    const hz = (k * rate) / FRAME;
    if (hz < MIN_HZ || hz > MAX_HZ) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    binClass[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames: Float32Array[] = [];
  const total = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);

  for (let f = 0; f < total; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[offset + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);

    const chroma = new Float32Array(12);
    for (let k = 1; k < FRAME / 2; k++) {
      const c = binClass[k]!;
      if (c >= 0) chroma[c]! += Math.hypot(re[k]!, im[k]!);
    }
    let norm = 0;
    for (const v of chroma) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let c = 0; c < 12; c++) chroma[c]! /= norm;
    frames.push(chroma);

    if (f % 64 === 0) {
      throwIfAborted(opts.signal);
      opts.onProgress?.(f / total);
      await yieldToUi();
    }
  }
  return frames;
}

/** Averages frames into blocks, re-normalised, so one block is roughly a beat or two. */
export function blockChroma(frames: readonly Float32Array[]): Float32Array[] {
  const blocks: Float32Array[] = [];
  for (let start = 0; start + BLOCK_FRAMES <= frames.length; start += BLOCK_FRAMES) {
    const block = new Float32Array(12);
    for (let f = start; f < start + BLOCK_FRAMES; f++) {
      for (let c = 0; c < 12; c++) block[c]! += frames[f]![c]!;
    }
    let norm = 0;
    for (const v of block) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let c = 0; c < 12; c++) block[c]! /= norm;
    blocks.push(block);
  }
  return blocks;
}

function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let c = 0; c < 12; c++) dot += a[c]! * b[c]!;
  return dot;
}

/**
 * Foote checkerboard novelty: high where the blocks before a point resemble
 * each other, the blocks after resemble each other, and the two sides do not
 * resemble one another. Index i is the boundary at the start of block i.
 */
export function noveltyCurve(blocks: readonly Float32Array[], kernel = KERNEL): number[] {
  const novelty = new Array<number>(blocks.length).fill(0);
  for (let i = kernel; i + kernel <= blocks.length; i++) {
    let sum = 0;
    for (let a = -kernel; a < kernel; a++) {
      for (let b = -kernel; b < kernel; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        sum += sign * similarity(blocks[i + a]!, blocks[i + b]!);
      }
    }
    novelty[i] = sum;
  }
  return novelty;
}

/**
 * Seconds until sound first starts and stays: the first 50 ms window whose RMS
 * clears a fraction of the loudest one, for three windows running. `null` if
 * the signal is silent.
 */
export function firstOnset(samples: Float32Array, rate: number, ratio = 0.1): number | null {
  const win = Math.max(1, Math.round(rate * 0.05));
  const rms: number[] = [];
  for (let start = 0; start + win <= samples.length; start += win) {
    let sum = 0;
    for (let i = start; i < start + win; i++) sum += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(sum / win));
  }
  const peak = Math.max(0, ...rms);
  if (peak <= 1e-6) return null;
  const threshold = peak * ratio;
  for (let i = 0; i + 3 <= rms.length; i++) {
    if (rms[i]! >= threshold && rms[i + 1]! >= threshold && rms[i + 2]! >= threshold) {
      return (i * win) / rate;
    }
  }
  return null;
}

export interface Analysis {
  novelty: number[];
  blockSeconds: number;
  rate: number;
  /**
   * Smallest novelty that counts as a real change. Novelty is compared to the
   * strongest peak, so without an absolute floor a steady, unchanging song
   * would have its faintest wobbles promoted to "section changes".
   */
  floor?: number;
}

/** The expensive part: chroma -> blocks -> novelty. */
export async function analyse(
  samples: Float32Array,
  rate: number,
  opts: Pick<SuggestOptions, "signal" | "onProgress"> = {},
): Promise<Analysis> {
  const frames = await chromaFrames(samples, rate, opts);
  return {
    novelty: noveltyCurve(blockChroma(frames)),
    blockSeconds: (BLOCK_FRAMES * HOP) / rate,
    rate,
    // A clean change scores about 2·KERNEL²·(1 − similarity); require a fraction of KERNEL².
    floor: 0.15 * KERNEL * KERNEL,
  };
}

// ── planning: which change belongs to which slide ────────────────────────

/** How strongly a section's chord-line count is trusted as a hint for its length. */
const LENGTH_PRIOR = 0.5;
/** Seconds the cover slide stays up before an opening Intro section takes over. */
export const TITLE_HOLD_SECONDS = 3;

export interface PlanSection {
  name: string;
  /** Chord lines on the slide — a rough measure of how long the section lasts. */
  lines: number;
  /** The section's lyric lines, when known. Used to find where it is sung. */
  lyrics?: string[];
}

/**
 * Picks `count` boundaries, in time order, that are both strong changes in the
 * audio and make the sections between them plausible lengths.
 *
 * `weights` has count+1 entries, one per stretch between boundaries (before
 * the first, ..., after the last). A weight is the section's relative length;
 * `null` means "no expectation" (an intro the chart doesn't describe). A
 * boundary that would make a 16-line verse last 5 seconds scores worse than
 * one that keeps it in proportion, which is what stops a loud fill from being
 * mistaken for a section change.
 *
 * Returns fewer than `count` if the audio doesn't have that many usable
 * changes — the caller leaves the remaining slides uncued.
 */
export function chooseBoundaries(
  analysis: Analysis,
  count: number,
  weights: ReadonlyArray<number | null>,
  minGapSeconds: number,
): number[] {
  const { novelty, blockSeconds } = analysis;
  const total = novelty.length * blockSeconds;
  const max = Math.max(0, ...novelty);
  if (count <= 0 || max <= 0 || max < (analysis.floor ?? 0)) return [];

  // Candidates: local maxima that aren't just noise, far enough from both ends.
  const cand: Array<{ t: number; v: number }> = [];
  for (let i = 1; i < novelty.length - 1; i++) {
    const v = novelty[i]! / max;
    const t = i * blockSeconds;
    if (v >= 0.1 && novelty[i]! >= (analysis.floor ?? 0) && novelty[i]! >= novelty[i - 1]! && novelty[i]! > novelty[i + 1]! && t >= minGapSeconds && t <= total - minGapSeconds) {
      cand.push({ t, v });
    }
  }

  for (let m = Math.min(count, cand.length); m >= 1; m--) {
    const w = weights.slice(0, m + 1);
    const known = w.reduce<number>((sum, x) => sum + (x ?? 0), 0) || 1;
    const penalty = (weight: number | null | undefined, duration: number) => {
      if (weight == null) return 0;
      const expected = (total * weight) / known;
      return LENGTH_PRIOR * Math.log(duration / expected) ** 2;
    };

    // dp[j][c]: best score with boundary j+1 at candidate c.
    const dp: number[][] = [];
    const back: number[][] = [];
    for (let j = 0; j < m; j++) {
      dp.push(new Array<number>(cand.length).fill(-Infinity));
      back.push(new Array<number>(cand.length).fill(-1));
      for (let c = 0; c < cand.length; c++) {
        if (j === 0) {
          dp[0]![c] = cand[c]!.v - penalty(w[0], cand[c]!.t);
          continue;
        }
        for (let p = 0; p < c; p++) {
          const gap = cand[c]!.t - cand[p]!.t;
          if (gap < minGapSeconds || dp[j - 1]![p]! === -Infinity) continue;
          const score = dp[j - 1]![p]! + cand[c]!.v - penalty(w[j], gap);
          if (score > dp[j]![c]!) {
            dp[j]![c] = score;
            back[j]![c] = p;
          }
        }
      }
    }

    let best = -Infinity;
    let bestC = -1;
    for (let c = 0; c < cand.length; c++) {
      const score = dp[m - 1]![c]! - penalty(w[m], total - cand[c]!.t);
      if (score > best) {
        best = score;
        bestC = c;
      }
    }
    if (bestC < 0 || best === -Infinity) continue;

    const chosen: number[] = [];
    for (let j = m - 1, c = bestC; j >= 0; j--) {
      chosen.push(cand[c]!.t);
      c = back[j]![c]!;
    }
    return chosen.reverse().map((t) => Math.round(t * 10) / 10);
  }
  return [];
}

/**
 * True when slide 0 is a cover, not a song section: it has no chords while a
 * later slide does. (A hand-built deck of plain text slides has no cover.)
 */
export function hasCoverSlide(sections: readonly PlanSection[]): boolean {
  return sections.length > 1 && sections[0]!.lines === 0 && sections.slice(1).some((s) => s.lines > 0);
}

/**
 * One start time per slide, running forward; `undefined` = leave uncued.
 *
 * The cover slide is not a part of the song, so it must not use up a change
 * in the audio. That was the earlier bug: with slides Title / Intro / Verse 1,
 * the cover took the intro's time and every section after it arrived one part
 * late. Now:
 *  - the cover starts at 0;
 *  - a chart that opens with an **Intro** section has that section start with
 *    the song (after a short title hold), and each later section takes the
 *    next change;
 *  - a chart that opens straight on a verse has its instrumental intro under
 *    the cover, so the first change is where that verse begins — unless the
 *    vocals stem shows singing right from the start.
 */
export function planCues(
  analysis: Analysis,
  sections: readonly PlanSection[],
  opts: { vocalsOnset?: number | null; minGapSeconds?: number } = {},
): Array<number | undefined> {
  const n = sections.length;
  if (n === 0) return [];
  const out: Array<number | undefined> = new Array<number | undefined>(n).fill(undefined);
  if (n === 1) return [0];

  const cover = hasCoverSlide(sections);
  const parts = sections.slice(cover ? 1 : 0);
  const introFirst = /^intro/i.test(parts[0]!.name);
  const singingFromStart = opts.vocalsOnset != null && opts.vocalsOnset < 4;
  const introUnderCover = cover && !introFirst && !singingFromStart;

  const weights = parts.map((p) => Math.max(1, p.lines));
  const count = introUnderCover ? parts.length : parts.length - 1;
  const bounds = chooseBoundaries(
    analysis,
    count,
    introUnderCover ? [null, ...weights] : weights,
    opts.minGapSeconds ?? 6,
  );

  if (cover) out[0] = 0;
  const offset = cover ? 1 : 0;
  if (introUnderCover) {
    bounds.forEach((t, j) => (out[offset + j] = t));
  } else {
    // Part 0 starts with the song; later parts take the changes in order.
    out[offset] = cover ? Math.min(TITLE_HOLD_SECONDS, (bounds[0] ?? Infinity) / 2) : 0;
    bounds.forEach((t, j) => (out[offset + 1 + j] = t));
  }
  return strictlyForward(out);
}

/**
 * Leaves uncued any slide whose time is not later than the last cued slide
 * before it. Equal times count: two slides on one instant means the clock can
 * only ever show one of them, and an honest gap beats an invented time.
 */
function strictlyForward(times: Array<number | undefined>): Array<number | undefined> {
  let last = -Infinity;
  return times.map((t) => {
    if (t === undefined || t <= last) return undefined;
    last = t;
    return t;
  });
}

/** A stretch of the analysis, for placing sections inside a gap. `offset` converts back to song time. */
function sliceAnalysis(analysis: Analysis, from: number, to: number): { analysis: Analysis; offset: number } {
  const lo = Math.max(0, Math.floor(from / analysis.blockSeconds));
  const hi = Math.min(analysis.novelty.length, Math.ceil(to / analysis.blockSeconds));
  return { analysis: { ...analysis, novelty: analysis.novelty.slice(lo, Math.max(lo, hi)) }, offset: lo * analysis.blockSeconds };
}

/**
 * Moves each time to the strongest change in the audio within `toleranceSeconds`.
 * Times taken from where the lyrics are sung lag or lead the section change
 * (a pickup, a breath); the music knows where the change really is. A time with no change nearby is left alone.
 */
export function snapToNovelty(times: readonly number[], analysis: Analysis, toleranceSeconds: number): number[] {
  const tol = Math.max(1, Math.round(toleranceSeconds / analysis.blockSeconds));
  const floor = analysis.floor ?? 0;
  return times.map((t) => {
    const centre = Math.round(t / analysis.blockSeconds);
    let best = -1;
    let bestValue = floor;
    for (let i = Math.max(0, centre - tol); i <= Math.min(analysis.novelty.length - 1, centre + tol); i++) {
      if (analysis.novelty[i]! > bestValue) {
        bestValue = analysis.novelty[i]!;
        best = i;
      }
    }
    return best < 0 ? t : Math.round(best * analysis.blockSeconds * 10) / 10;
  });
}

/** How far the music may move a time found from the lyrics. */
const SNAP_SECONDS = 2.5;

/**
 * Times every slide from where its lyrics were found in the recording.
 *
 * Sections with lyrics that were matched are anchors, snapped to the nearest
 * real change in the music. Sections between anchors that have no words to
 * match (an instrumental intro, a solo, an outro) start where the previous
 * section's singing ended; when several sit in one gap, the music's changes
 * split it. The cover slide starts at 0 and never uses up a section's time.
 *
 * Returns null when too few sections were found for the result to be
 * trustworthy, so the caller can use the audio-only plan instead.
 */
export function planFromMatches(
  analysis: Analysis,
  sections: readonly PlanSection[],
  matches: ReadonlyArray<{ start: number; end: number } | null>,
  opts: { minGapSeconds?: number } = {},
): Array<number | undefined> | null {
  const n = sections.length;
  const lyricSections = sections.filter((s) => (s.lyrics?.length ?? 0) > 0).length;
  const found = matches.filter((m) => m !== null).length;
  if (n < 2 || found < 2 || found < lyricSections / 2) return null;

  const total = analysis.novelty.length * analysis.blockSeconds;
  const cover = hasCoverSlide(sections);
  const times: Array<number | undefined> = new Array<number | undefined>(n).fill(undefined);
  const ends: number[] = new Array<number>(n).fill(0);
  if (cover) times[0] = 0;

  // Anchors: matched sections, kept only while they run forward.
  let previous = 0;
  for (let i = cover ? 1 : 0; i < n; i++) {
    const m = matches[i];
    if (!m) continue;
    const t = Math.max(previous, snapToNovelty([m.start], analysis, SNAP_SECONDS)[0]!);
    times[i] = t;
    ends[i] = Math.max(t, m.end);
    previous = t;
  }

  // Fill each run of unanchored sections between two anchors (or the ends).
  const minGap = opts.minGapSeconds ?? 4;
  let i = cover ? 1 : 0;
  let runStartTime = cover ? Math.min(TITLE_HOLD_SECONDS, total / 4) : 0;
  while (i < n) {
    if (times[i] !== undefined) {
      runStartTime = ends[i]!;
      i++;
      continue;
    }
    let j = i;
    while (j < n && times[j] === undefined) j++;
    const nextTime = j < n ? times[j]! : total;
    const from = runStartTime;
    if (nextTime - from >= 1) {
      times[i] = Math.round(Math.min(from, nextTime) * 10) / 10;
      const rest = j - i - 1;
      if (rest > 0) {
        const slice = sliceAnalysis(analysis, from, nextTime);
        const weights = sections.slice(i, j).map((s) => Math.max(1, s.lines));
        const bounds = chooseBoundaries(slice.analysis, rest, weights, minGap);
        bounds.forEach((t, k) => (times[i + 1 + k] = Math.round((t + slice.offset) * 10) / 10));
      }
    }
    i = j;
  }

  return strictlyForward(times);
}
