import { z } from "zod";
import { Block } from "./blocks.js";

export const SCHEMA_VERSION = 3;

/**
 * Modes are spelled out rather than collapsed to major/minor because the
 * distinction changes roman-numeral derivation. `major`/`minor` are accepted as
 * the everyday aliases for ionian/aeolian.
 */
export const Mode = z.enum([
  "major",
  "minor",
  "ionian",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "aeolian",
  "locrian",
  "harmonic-minor",
  "melodic-minor",
]);
export type Mode = z.infer<typeof Mode>;

/** Pitch-class letter with optional accidentals: C, F#, Bb, C##. */
const TONIC = /^[A-G](#{1,2}|b{1,2})?$/;

export const KeyRef = z.object({
  tonic: z.string().regex(TONIC, "tonic must look like C, F#, or Bb"),
  mode: Mode,
});
export type KeyRef = z.infer<typeof KeyRef>;

export const SectionType = z.enum([
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "post-chorus",
  "bridge",
  "solo",
  "instrumental",
  "breakdown",
  "outro",
  "other",
]);
export type SectionType = z.infer<typeof SectionType>;

export const Section = z
  .object({
    id: z.uuid(),
    /** Display name, free-form: "Chorus 2", "Verse (half-time)". */
    name: z.string().min(1),
    /** Drives region color on the waveform and grouping in the graph. */
    type: SectionType.default("other"),

    /** Seconds from the start of the audio file. */
    start: z.number().nonnegative(),
    end: z.number().positive(),

    /**
     * Overrides the song key for this section only. Two distinct uses:
     *   1. real modulation (the last chorus goes up a tone)
     *   2. modal reinterpretation — a section whose chords are nominally in
     *      C major but which *functions* in A minor. Getting this wrong
     *      silently poisons every graph edge derived from the section, so it
     *      is worth setting explicitly rather than inheriting.
     */
    key: KeyRef.optional(),

    /**
     * THE GRAPH'S INPUT. An ordered list of chord symbols as actually played:
     * ["C", "G", "Am", "F"]. Repeats collapse (write the loop once), but the
     * starting chord matters and is preserved — I-V-vi-IV and vi-IV-I-V are
     * stored differently even though they share a canonical rotation.
     *
     * Kept separate from any chordChart block on purpose: the chart is layout,
     * this is harmony. One section can have several charts (verse variations)
     * but exactly one progression.
     */
    progression: z.array(z.string().min(1)).default([]),

    /**
     * Manual override for derived roman numerals. Leave undefined and they are
     * computed from `progression` + effective key at read time. Set it when the
     * automatic reading is wrong (secondary dominants, borrowed chords,
     * anything where the label is an interpretation rather than a lookup).
     */
    romanNumerals: z.array(z.string().min(1)).optional(),

    /**
     * Markdown. On the eventual move to Markdown-as-source this is lifted into
     * the document body under a `## <name>` heading; see README.
     */
    notes: z.string().optional(),

    blocks: z.array(Block).default([]),
  })
  .refine((s) => s.end > s.start, {
    message: "section end must be after start",
    path: ["end"],
  })
  .refine((s) => s.romanNumerals === undefined || s.romanNumerals.length === s.progression.length, {
    message: "romanNumerals override must have one entry per chord in progression",
    path: ["romanNumerals"],
  });

export type Section = z.infer<typeof Section>;

/**
 * A local audio file, decoded in the page — WaveSurfer draws a real waveform
 * from it and sections are marked by dragging on that waveform.
 *
 * This was briefly a `file | youtube` union. The YouTube arm is gone (v3): an
 * embedded video is opaque to the page, so it could never produce a waveform,
 * and its presence as a cross-origin iframe blocked the cross-origin isolation
 * that in-browser stem separation needs.
 */
export const AudioRef = z.object({
  /**
   * Relative to the song's own directory (`audio.mp3`, `assets/take2.flac`).
   * The Electron adapter additionally accepts an absolute path so large
   * libraries need not be copied; the browser adapter cannot reach outside the
   * chosen library root and will reject one.
   */
  path: z.string().min(1),
  /** Seconds. Filled in on import from file metadata. */
  duration: z.number().positive().optional(),
  /** Detects a file swapped underneath a saved analysis. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type AudioRef = z.infer<typeof AudioRef>;

export const Song = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.uuid(),

    title: z.string().min(1),
    artist: z.string().optional(),
    album: z.string().optional(),
    year: z.number().int().min(1000).max(2999).optional(),

    key: KeyRef,
    tempo: z.number().positive().max(400).optional(),
    timeSignature: z
      .string()
      .regex(/^\d{1,2}\/\d{1,2}$/, 'timeSignature must look like "4/4"')
      .default("4/4"),

    /**
     * Optional since v3: a song that only ever had a YouTube source has no
     * local file, and inventing a fake path would be worse than modelling
     * "analysis without a track", which is a coherent state.
     */
    audio: AudioRef.optional(),
    tags: z.array(z.string().min(1)).default([]),
    sections: z.array(Section).default([]),

    /** Song-level markdown. Becomes the document body's preamble on migration. */
    notes: z.string().optional(),

    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((song, ctx) => {
    // The sync engine binary-searches this array and assumes exactly one
    // section can be active at a time. Enforce that invariant at the boundary
    // rather than defending against it at 60fps.
    for (let i = 1; i < song.sections.length; i++) {
      const prev = song.sections[i - 1]!;
      const cur = song.sections[i]!;
      if (cur.start < prev.start) {
        ctx.addIssue({
          code: "custom",
          message: `sections must be sorted by start time ("${cur.name}" precedes "${prev.name}")`,
          path: ["sections", i, "start"],
        });
      } else if (cur.start < prev.end) {
        ctx.addIssue({
          code: "custom",
          message: `sections must not overlap ("${prev.name}" ends at ${prev.end}, "${cur.name}" starts at ${cur.start})`,
          path: ["sections", i, "start"],
        });
      }
    }

    const seen = new Set<string>();
    for (const [i, s] of song.sections.entries()) {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: "custom", message: "duplicate section id", path: ["sections", i, "id"] });
      }
      seen.add(s.id);
    }
  });

export type Song = z.infer<typeof Song>;

/** What a library listing needs — cheap to build, no need to parse every song. */
export const SongSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  artist: z.string().optional(),
  tags: z.array(z.string()).default([]),
  updatedAt: z.iso.datetime(),
  /** False for songs whose audio was removed by the v3 migration. */
  hasAudio: z.boolean(),
});
export type SongSummary = z.infer<typeof SongSummary>;

export function summarize(song: Song): SongSummary {
  return {
    id: song.id,
    title: song.title,
    ...(song.artist !== undefined ? { artist: song.artist } : {}),
    tags: song.tags,
    updatedAt: song.updatedAt,
    hasAudio: song.audio !== undefined,
  };
}

/** The key a section is actually in, falling back to the song's. */
export function effectiveKey(song: Song, section: Section): KeyRef {
  return section.key ?? song.key;
}

/** Section active at time `t`, or null in a gap. O(log n); safe to call at 60fps. */
export function sectionAt(sections: readonly Section[], t: number): Section | null {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sections[mid]!;
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return s;
  }
  return null;
}

/**
 * Upgrades a raw song object of any known past schema version to the
 * current one. Songs are user data on disk (hard rule #6) — there is no
 * "just delete the library," so every reader goes through this before
 * validating, not just the ones written after a given change.
 */
export function migrateSong(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  let song = data as Record<string, unknown>;

  // Steps chain rather than return early, so a v1 file on disk is carried all
  // the way to the current version rather than stopping one short.

  // v1 -> v2: `audio` gained a `kind` discriminant (`file` | `youtube`).
  // Every v1 song was implicitly a file.
  if (song.schemaVersion === 1) {
    const audio = song.audio as Record<string, unknown> | undefined;
    song = {
      ...song,
      schemaVersion: 2,
      audio: audio && !("kind" in audio) ? { kind: "file", ...audio } : audio,
    };
  }

  // v2 -> v3: the `youtube` arm is gone and `audio` became optional. A song
  // that only ever had a video has no local file, so it loses its audio — but
  // the video id is appended to `notes` rather than dropped, since it is the
  // only record of what the song was and re-finding it by hand is tedious.
  if (song.schemaVersion === 2) {
    const audio = song.audio as Record<string, unknown> | undefined;
    if (audio?.kind === "youtube") {
      const note = `[Audio source removed in v3 — was YouTube video ${String(audio.videoId)}]`;
      const existing = typeof song.notes === "string" && song.notes.trim() !== "" ? song.notes : "";
      const { audio: _dropped, ...rest } = song;
      song = {
        ...rest,
        schemaVersion: 3,
        notes: existing ? `${existing}\n\n${note}` : note,
      };
    } else {
      const { kind: _kind, ...file } = audio ?? {};
      song = { ...song, schemaVersion: 3, ...(audio ? { audio: file } : {}) };
    }
  }

  return song;
}

export function parseSong(data: unknown): Song {
  return Song.parse(migrateSong(data));
}

export function safeParseSong(data: unknown) {
  return Song.safeParse(migrateSong(data));
}

export function newSong(init: {
  id: string;
  title: string;
  key: KeyRef;
  audio: { path: string };
}): Song {
  const now = new Date().toISOString();
  return Song.parse({
    schemaVersion: SCHEMA_VERSION,
    id: init.id,
    title: init.title,
    key: init.key,
    audio: init.audio,
    createdAt: now,
    updatedAt: now,
  });
}
