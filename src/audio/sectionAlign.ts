import { emissionsFor, SECONDS_PER_FRAME, type AlignProgress, type RunSession } from "./alignModel.js";
import { forcedAlign, normalizeForVocab, spansToWords, VOCAB } from "./ctcAlign.js";
import type { SectionMatch } from "./lyricSync.js";

/**
 * Finds where each section's known lyrics are sung, for `planFromMatches`.
 *
 * Inference runs once over the whole song (logits are small, ~1.5 MB for six
 * minutes). Alignment does not: a trellis of the whole song against the whole
 * lyric is song × lyric sized (~100 MB for six dense minutes). Instead each
 * section is aligned on its own, in a window that starts where the last
 * confidently placed section ended. Sections run in order, so that window is
 * where the next one must begin; a section that can't be placed is left null
 * and the next one searches from the same anchor, so one miss does not drag
 * the rest along with it.
 */

/** Long enough to hold a section plus an instrumental break before it; memory grows linearly with it. */
export const WINDOW_SECONDS = 60;
const WINDOW_FRAMES = Math.round(WINDOW_SECONDS / SECONDS_PER_FRAME);
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
// placed by borrowing letters spread across other words.
const LEAD = VOCAB.length;
const TRAIL = VOCAB.length + 1;
// Log-probability per frame (2.5 per second) the trailing filler scores above the frame's best token, so finishing a
// frame earlier always pays and a repeated chorus resolves to its next occurrence: a later one wins only if it explains
// the audio better by more than that, e.g. ~5 more clearly heard characters 20 s later. Without it one misheard letter
// hands chorus 1's slot to chorus 2 and the rest cascade. (A penalty on the leading filler instead does not work: the
// path crosses silence on plain blank, so it would only be charged on sung frames.) Cost: the last character may be
// trimmed to its first frame.
const EARLY_BIAS = 0.05;

/**
 * Bytes one section's alignment allocates for a window of `frames` and
 * `tokens` lyric characters: the window's rows (copied to add the filler
 * columns) plus `forcedAlign`'s own buffers, where the frames × states
 * backpointer table dominates.
 */
export function alignmentBytes(frames: number, tokens: number): number {
  const states = 2 * (tokens + 2) + 1;
  return frames * (VOCAB.length + 2) * 4 + frames * states + frames * (4 + 8) + states * (8 + 8 + 4);
}

/** The most any one section can allocate, whatever the song's length: one window against the token cap (~9.5 MB). */
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

  let anchor = 0;
  for (const [i, section] of tokens.entries()) {
    if (section.length === 0 || section.length > MAX_SECTION_TOKENS) continue;
    const ids = section.map((t) => (VOCAB as readonly string[]).indexOf(t));
    const end = Math.min(frames, anchor + WINDOW_FRAMES);
    const rows: Float32Array[] = [];
    for (let f = anchor; f < end; f++) {
      const r = new Float32Array(vocabSize + 2);
      r.set(row(f));
      let best = -Infinity;
      for (let v = 0; v < vocabSize; v++) if (r[v]! > best) best = r[v]!;
      r[LEAD] = best;
      r[TRAIL] = best + EARLY_BIAS;
      rows.push(r);
    }

    let spans;
    try {
      spans = forcedAlign(rows, [LEAD, ...ids, TRAIL], BLANK_ID).slice(1, -1);
    } catch {
      continue;
    }
    for (const span of spans) span.tokenIndex -= 1;
    const last = spans.at(-1)!.endFrame;

    let confidence = 0;
    for (const span of spans) {
      let heard = 0;
      for (let f = span.startFrame; f < span.endFrame; f++) heard += probability(row(anchor + f), ids[span.tokenIndex]!);
      confidence += heard / (span.endFrame - span.startFrame) / spans.length;
    }
    if (confidence < MIN_SECTION_CONFIDENCE) continue;

    const words = spansToWords(spans, section);
    out[i] = { start: seconds(anchor + words[0]!.startFrame), end: seconds(anchor + words.at(-1)!.endFrame) };
    anchor += last;
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
