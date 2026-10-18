import type { Slide } from "../schema/deck.js";
import { ALIGN_SAMPLE_RATE, type AlignProgress, type RunSession } from "./alignModel.js";
import { decodeMono } from "./decodeMono.js";
import { analyse, firstOnset, planCues, planFromMatches, type PlanSection } from "./segment.js";
import { alignSections } from "./sectionAlign.js";

const RATE = 22050;

export interface AutoCueOptions {
  /** Separated vocals stem, if the deck has one — shows whether singing starts at once or after an intro. */
  vocals?: Blob;
  /** Try the lyric-based timing (aligns the lyrics to the audio in the browser). Default true. */
  useLyrics?: boolean;
  signal?: AbortSignal;
  /** 0..1, never decreasing; `detail` says what is happening when it is worth saying, e.g. the model download. */
  onProgress?: (fraction: number, detail?: string) => void;
  /** Alignment inference; the real model by default. */
  run?: RunSession;
}

export interface AutoCueResult {
  /** One entry per slide; `undefined` = leave uncued. */
  times: Array<number | undefined>;
  /** "lyrics": timed from where the lyrics are sung. "music": from changes in the music alone. */
  source: "lyrics" | "music";
  /** Why lyric timing wasn't used, when it was wanted. */
  note?: string;
}

/** What the planner knows about each slide when only the deck is available: its name, chord-line count and lyrics. */
export function sectionsOfSlides(slides: readonly Slide[]): PlanSection[] {
  return slides.map((slide) => {
    const tab = slide.elements.find((el) => el.kind === "tab");
    const lines = tab && tab.text.trim() ? tab.text.split("\n").length : 0;
    // A lyric is a line in a layout "body" placeholder, except on the "centered" title-slide layout, whose body holds artist/key/tuning; titles, user-added text boxes and tabs never are.
    const lyrics = slide.layout === "centered" ? [] : slide.elements.flatMap((el) =>
      el.kind === "text" && el.role === "body" ? el.text.split("\n").map((l) => l.trim()).filter(Boolean) : [],
    );
    return lyrics.length > 0 ? { name: slide.name, lines, lyrics } : { name: slide.name, lines };
  });
}

/**
 * Suggested start time for every slide, from the audio.
 *
 * When the sections carry their lyrics, each section is found by aligning its
 * words to the recording in the browser (`alignSections`; nothing is sent
 * anywhere), preferring the vocals stem; the music then snaps each time to a
 * real change. Without lyrics, or if that fails or matches too little, the
 * plan uses changes in the music alone, and says so.
 */
export async function cuesForAudio(
  mix: Blob,
  sections: readonly PlanSection[],
  opts: AutoCueOptions = {},
): Promise<AutoCueResult> {
  let shown = 0;
  const report = (fraction: number, detail?: string) => {
    shown = Math.max(shown, fraction);
    opts.onProgress?.(shown, detail);
  };

  const hasLyrics = sections.some((s) => (s.lyrics?.length ?? 0) > 0);
  const useLyrics = opts.useLyrics !== false && hasLyrics;
  const rates = useLyrics ? [RATE, ALIGN_SAMPLE_RATE] : [RATE];
  const [samples, mix16] = await decodeMono(await mix.arrayBuffer(), rates);
  const [vocals, vocals16] = opts.vocals ? await decodeMono(await opts.vocals.arrayBuffer(), rates) : [];
  if (samples instanceof Error) throw samples;
  if (vocals instanceof Error) throw vocals;
  const analysis = await analyse(samples!, RATE, {
    signal: opts.signal,
    onProgress: (f) => report(f * 0.5),
  });
  const fallback = () =>
    planCues(analysis, sections, { vocalsOnset: vocals ? firstOnset(vocals, RATE) : undefined });

  if (!useLyrics) {
    report(1);
    return { times: fallback(), source: "music" };
  }

  try {
    // The 16 kHz copies exist only for alignment, so failing to make one falls back to the music like any other alignment failure.
    if (mix16 instanceof Error) throw mix16;
    if (vocals16 instanceof Error) throw vocals16;
    const matches = await alignSections({ mix: mix16!, vocals: vocals16 }, sections, {
      run: opts.run,
      signal: opts.signal,
      onProgress: (p) => report(...alignProgress(p)),
    });
    const planned = planFromMatches(analysis, sections, matches);
    report(1);
    if (planned) return { times: planned, source: "lyrics" };
    return {
      times: fallback(),
      source: "music",
      note: matches.every((m) => m === null)
        ? "none of the lyrics could be found in the recording"
        : "too few sections could be found in the recording",
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    report(1);
    return { times: fallback(), source: "music", note: err instanceof Error ? err.message : String(err) };
  }
}

/** Alignment's stages onto the second half of the bar: the first-run model download, then loading it, then inference. */
function alignProgress(p: AlignProgress): [number, string?] {
  const f = p.fraction ?? 0;
  switch (p.stage) {
    case "downloading":
      return [0.5 + 0.25 * f, `Downloading the lyric alignment model (first time only)${p.detail ? ` — ${p.detail}` : ""}`];
    case "loading":
      return [0.75, "Loading the lyric alignment model"];
    case "inferring":
      return [0.75 + 0.23 * f, "Listening for the lyrics"];
  }
}
