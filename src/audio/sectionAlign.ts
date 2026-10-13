import { emissionsFor, SECONDS_PER_FRAME, type AlignProgress, type RunSession } from "./alignModel.js";
import { forcedAlign, normalizeForVocab, VOCAB } from "./ctcAlign.js";

/**
 * Finds where each section's known lyrics are sung, for `planFromMatches`.
 *
 * Inference runs once over the whole song (logits are small, ~1.5 MB for six
 * minutes). Alignment does not: a trellis of the whole song against the whole
 * lyric is song × lyric sized (~100 MB for six dense minutes). Instead each
 * section is aligned on its own, in a window that starts where the last
 * confidently placed section ended. Sections run in order, so that is where
 * the next one must begin. If nothing in that window is a confident match,
 * the window slides on until one is or the song ends, so a long instrumental
 * break does not strand every later section. A section that can't be placed
 * is left null without moving the anchor: where a forced placement of lyrics
 * that aren't sung lands says nothing about where the song has got to, and
 * trusting it could skip the next real section.
 */

export interface SectionMatch { start: number; end: number }

/** Long enough to hold a section plus an instrumental break before it; memory grows linearly with it. */
export const WINDOW_SECONDS = 60;
const WINDOW_FRAMES = Math.round(WINDOW_SECONDS / SECONDS_PER_FRAME);
/** How far the window slides when it holds no confident match. Consecutive windows overlap by 40 s, so any section sung in up to 40 s lies wholly inside one of them. */
const STEP_FRAMES = Math.round(20 / SECONDS_PER_FRAME);
/** Characters in one section's lyrics (~300 words, a dense rap verse); longer sections are left unplaced rather than growing the trellis. */
export const MAX_SECTION_TOKENS = 1500;
/**
 * Mean over a placed section's characters of each one's mean probability on
 * its frames (`TokenSpan.score`, recomputed against the model's own softmax).
 * Words placed on silence, or on sounds the model hears as other letters, sit
 * near chance (1/32); a real placement has the model agreeing on most of its
 * characters. Below half, a wrong cue (which moves a slide to the wrong place)
 * is likelier than a right one, and null falls back to the music instead.
 */
export const MIN_SECTION_CONFIDENCE = 0.5;

const BLANK_ID = 0;
// Filler states either side of the section, scored as well as the frame's best token, so the window's other singing is
// "anything" rather than forced blank — otherwise the path stretches to swallow the next section, and wrong lyrics get
// placed by borrowing letters spread across other words. Never better than the best token, so the path gains nothing by
// moving a frame the model hears as the lyric into a filler: a section's edges only give up frames where the model
// hears something else more. The fillers sit a hair below the best token so that exact ties stay with the lyric, and
// each gets one synthetic frame of its own at the window's edge, since CTC makes every target token take a frame.
const LEAD = VOCAB.length;
const TRAIL = VOCAB.length + 1;
const FILLER_TIE = 1e-3;

/**
 * Bytes one alignment allocates for a window of `frames` and `tokens` lyric
 * characters: the window's rows (copied to add the filler columns and edge
 * frames) plus `forcedAlign`'s own buffers, where the frames × states
 * backpointer table dominates.
 */
export function alignmentBytes(frames: number, tokens: number): number {
  const states = 2 * (tokens + 2) + 1;
  frames += 2;
  return frames * (VOCAB.length + 2) * 4 + frames * states + frames * (4 + 8) + states * (8 + 8 + 4);
}

/** The most any one alignment can allocate, whatever the song's length: one window against the token cap (~9.5 MB). Alignments run one at a time. */
export const WORST_CASE_ALIGNMENT_BYTES = alignmentBytes(WINDOW_FRAMES, MAX_SECTION_TOKENS);

/**
 * One entry per section: where its lyrics are sung, in seconds, or null where
 * it has no lyrics or could not be placed confidently. Audio is 16 kHz mono;
 * the vocals stem is used when given, because an isolated voice aligns far
 * more reliably than a full mix.
 */
export async function alignSections(
  audio: { mix: Float32Array; vocals?: Float32Array },
  sections: ReadonlyArray<{ lyrics?: readonly string[] }>,
  opts: { run?: RunSession; onProgress?: (p: AlignProgress) => void } = {},
): Promise<Array<SectionMatch | null>> {
  const out: Array<SectionMatch | null> = sections.map(() => null);
  const tokens = sections.map((s) => normalizeForVocab((s.lyrics ?? []).join(" ")));
  if (!tokens.some((t) => t.length > 0 && t.length <= MAX_SECTION_TOKENS)) return out;

  const { logits, frames, vocabSize } = await emissionsFor(audio.vocals ?? audio.mix, opts.onProgress, opts.run);
  const row = (f: number) => logits.subarray(f * vocabSize, (f + 1) * vocabSize);

  /** The best placement of `ids` in frames [from, to), with its confidence, or null if it cannot fit. */
  function place(ids: number[], from: number, to: number) {
    const edge = (filler: number) => new Float32Array(vocabSize + 2).fill(-Infinity).fill(0, filler, filler + 1);
    const rows: Float32Array[] = [edge(LEAD)];
    for (let f = from; f < to; f++) {
      const r = new Float32Array(vocabSize + 2);
      r.set(row(f));
      let best = -Infinity;
      for (let v = 0; v < vocabSize; v++) if (r[v]! > best) best = r[v]!;
      r[LEAD] = r[TRAIL] = best - FILLER_TIE;
      rows.push(r);
    }
    rows.push(edge(TRAIL));
    let spans;
    try {
      spans = forcedAlign(rows, [LEAD, ...ids, TRAIL], BLANK_ID).slice(1, -1);
    } catch {
      return null;
    }
    let confidence = 0;
    for (const span of spans) {
      let heard = 0;
      for (let f = span.startFrame; f < span.endFrame; f++) heard += probability(row(from + f - 1), ids[span.tokenIndex - 1]!);
      confidence += heard / (span.endFrame - span.startFrame) / spans.length;
    }
    return { start: from + spans[0]!.startFrame - 1, end: from + spans.at(-1)!.endFrame - 1, confidence };
  }

  // The earliest confident placement in [from, to). Viterbi returns the best-scoring one, which for a repeated chorus may
  // be a later, more clearly heard repeat; re-aligning in the stretch before it finds any earlier one. Choosing outside
  // the trellis, rather than rewarding early finishes per frame inside it, keeps that reward from also paying the path to
  // trim ambiguous frames off the lyric.
  function earliest(ids: number[], from: number, to: number) {
    let found = place(ids, from, to);
    if (!found || found.confidence < MIN_SECTION_CONFIDENCE) return null;
    for (;;) {
      const earlier = place(ids, from, found.start);
      if (!earlier || earlier.confidence < MIN_SECTION_CONFIDENCE) return found;
      found = earlier;
    }
  }

  let anchor = 0;
  for (const [i, section] of tokens.entries()) {
    if (section.length === 0 || section.length > MAX_SECTION_TOKENS) continue;
    const ids = section.map((t) => (VOCAB as readonly string[]).indexOf(t));
    for (let from = anchor; from < frames; from += STEP_FRAMES) {
      const to = Math.min(frames, from + WINDOW_FRAMES);
      const found = earliest(ids, from, to);
      if (found) {
        out[i] = { start: seconds(found.start), end: seconds(found.end) };
        anchor = found.end;
        break;
      }
      if (to === frames) break;
    }
  }
  return out;
}

/** Softmax probability of `id` in one frame of logits. */
function probability(row: Float32Array, id: number): number {
  let max = -Infinity;
  for (const v of row) if (v > max) max = v;
  let sum = 0;
  for (const v of row) sum += Math.exp(v - max);
  return Math.exp(row[id]! - max) / sum;
}

const seconds = (frame: number) => Math.round(frame * SECONDS_PER_FRAME * 100) / 100;
