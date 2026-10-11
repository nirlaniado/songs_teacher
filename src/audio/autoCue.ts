import type { Slide } from "../schema/deck.js";
import { decodeMono } from "./decodeMono.js";
import { transcribeMix } from "./llmSync.js";
import { alignLyrics } from "./lyricSync.js";
import { analyse, firstOnset, planCues, planFromMatches, type PlanSection } from "./segment.js";

const RATE = 22050;

export interface AutoCueOptions {
  /** Separated vocals stem, if the deck has one — shows whether singing starts at once or after an intro. */
  vocals?: Blob;
  /** Try the lyric-based timing (transcribes the audio through the local service). Default true. */
  useLyrics?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface AutoCueResult {
  /** One entry per slide; `undefined` = leave uncued. */
  times: Array<number | undefined>;
  /** "lyrics": timed from the transcript. "music": from changes in the music alone. */
  source: "lyrics" | "music";
  /** Why lyric timing wasn't used, when it was wanted. */
  note?: string;
}

/** What the planner knows about each slide when only the deck is available: its name and chord-line count. */
export function sectionsOfSlides(slides: readonly Slide[]): PlanSection[] {
  return slides.map((slide) => {
    const tab = slide.elements.find((el) => el.kind === "tab");
    return { name: slide.name, lines: tab && tab.text.trim() ? tab.text.split("\n").length : 0 };
  });
}

/**
 * Suggested start time for every slide, from the audio.
 *
 * When the sections carry their lyrics, the recording is transcribed (the
 * audio goes to OpenAI via the local service) and each section is found by its
 * words; the music then snaps each time to a real change. Without lyrics, or
 * if that fails or matches too little, the plan uses changes in the music
 * alone, and says so.
 */
export async function cuesForAudio(
  mix: Blob,
  sections: readonly PlanSection[],
  opts: AutoCueOptions = {},
): Promise<AutoCueResult> {
  const samples = await decodeMono(await mix.arrayBuffer(), RATE);
  const vocals = opts.vocals ? await decodeMono(await opts.vocals.arrayBuffer(), RATE) : undefined;
  const analysis = await analyse(samples, RATE, {
    signal: opts.signal,
    onProgress: (f) => opts.onProgress?.(f * 0.5),
  });
  const fallback = () =>
    planCues(analysis, sections, { vocalsOnset: vocals ? firstOnset(vocals, RATE) : undefined });

  const hasLyrics = sections.some((s) => (s.lyrics?.length ?? 0) > 0);
  if (opts.useLyrics === false || !hasLyrics) {
    opts.onProgress?.(1);
    return { times: fallback(), source: "music" };
  }

  try {
    opts.onProgress?.(0.55);
    const phrases = await transcribeMix(mix, opts.signal);
    opts.onProgress?.(0.95);
    const planned = planFromMatches(analysis, sections, alignLyrics(phrases, sections));
    opts.onProgress?.(1);
    if (planned) return { times: planned, source: "lyrics" };
    return {
      times: fallback(),
      source: "music",
      note: phrases.length === 0
        ? "no singing could be transcribed"
        : "too few sections could be found in the transcript",
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    opts.onProgress?.(1);
    return { times: fallback(), source: "music", note: err instanceof Error ? err.message : String(err) };
  }
}
