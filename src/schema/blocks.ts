import { z } from "zod";

/**
 * Slide content blocks.
 *
 * A slide is an ordered list of typed blocks — not a free canvas. That keeps
 * content queryable (you can ask "show me every section with a modal
 * interchange note") and keeps rendering to plain React + CSS grid.
 *
 * V1 ships four kinds. Adding a fifth means: add an object below, add it to the
 * union, add a renderer. Nothing else in the codebase needs to know.
 *
 * Deliberately NOT blocks:
 *   - roman numerals  -> derived from `section.progression` + effective key,
 *                        rendered as an option on the chord chart
 *   - key / scale     -> lives on the song/section, rendered in slide chrome
 *   - tables          -> `text` blocks are GFM markdown; tables come free
 */

const BlockBase = z.object({
  id: z.uuid(),
});

/**
 * The visual chord chart. This is PRESENTATION — how harmony is laid out on the
 * slide (bar lines, splits, repeats). The graph does not read this.
 * `section.progression` is the harmonic source of truth. See song.ts.
 */
export const ChordChartBlock = BlockBase.extend({
  kind: z.literal("chordChart"),
  /** One entry per bar. A bar with two chords is a split bar. */
  bars: z
    .array(
      z.object({
        chords: z.array(z.string().min(1)).min(1),
        /**
         * Optional beat weights, parallel to `chords`, for uneven splits
         * (e.g. [3, 1] = three beats of the first chord, one of the second).
         * Omit for an even split.
         */
        beats: z.array(z.number().positive()).optional(),
        /** Free label above the bar: "x4", "N.C.", "let ring". */
        label: z.string().optional(),
      }),
    )
    .min(1),
  barsPerLine: z.number().int().positive().max(8).default(4),
  showRomanNumerals: z.boolean().default(false),
});

/** Observations, analysis prose, anything free-form. GFM markdown. */
export const TextBlock = BlockBase.extend({
  kind: z.literal("text"),
  markdown: z.string(),
  /** Rendering weight, not semantics. */
  emphasis: z.enum(["normal", "callout", "aside"]).default("normal"),
});

/** Diagrams, screenshots, hand-drawn analysis. Path is relative to the song dir. */
export const ImageBlock = BlockBase.extend({
  kind: z.literal("image"),
  src: z.string().min(1),
  caption: z.string().optional(),
  width: z.enum(["full", "half", "third"]).default("full"),
});

/** Fingerings. Shape matches what svguitar wants, so rendering is a direct map. */
export const GuitarChordBlock = BlockBase.extend({
  kind: z.literal("guitarChord"),
  chords: z
    .array(
      z.object({
        name: z.string().min(1),
        /**
         * Six entries, low E -> high E.
         * number = fret (0 = open), null = muted string.
         */
        frets: z.array(z.number().int().nonnegative().nullable()).length(6),
        /** Fret the diagram window starts at, for chords up the neck. */
        baseFret: z.number().int().positive().default(1),
      }),
    )
    .min(1),
});

export const Block = z.discriminatedUnion("kind", [
  ChordChartBlock,
  TextBlock,
  ImageBlock,
  GuitarChordBlock,
]);

export type Block = z.infer<typeof Block>;
export type BlockKind = Block["kind"];
export type ChordChartBlock = z.infer<typeof ChordChartBlock>;
export type TextBlock = z.infer<typeof TextBlock>;
export type ImageBlock = z.infer<typeof ImageBlock>;
export type GuitarChordBlock = z.infer<typeof GuitarChordBlock>;
