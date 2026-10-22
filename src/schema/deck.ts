import { z } from "zod";

/**
 * The presentation model.
 *
 * This is the app's primary document: a deck of slides you edit like Impress,
 * plus an optional audio track and per-slide cue times so the deck plays
 * itself alongside a song. Everything here is authored by hand.
 *
 * Coordinates live in a fixed 1280x720 logical space rather than percentages
 * or CSS pixels. One coordinate system means the editor canvas, the slide
 * panel thumbnails, and fullscreen presentation are the *same* renderer at
 * three different scales — no layout drifts between "editing" and "presenting",
 * which is the classic way slide editors go wrong.
 */

export const DECK_SCHEMA_VERSION = 2;

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const Color = z.string().regex(HEX, "must be a hex color like #1e293b");

/**
 * A flat color or a saved image. Used both for the deck theme (the backdrop
 * every slide inherits, i.e. the master) and for a single slide's override.
 *
 * `dim` paints black over the image at that opacity, beneath the slide's
 * elements. Photographic backgrounds routinely swallow text; without a dimmer
 * the only fix is editing the image outside the app.
 */
export const Background = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("color"),
    color: Color,
  }),
  z.object({
    kind: z.literal("image"),
    /** Relative to the deck's own directory, e.g. `assets/bg-a1b2.jpg`. */
    src: z.string().min(1),
    fit: z.enum(["cover", "contain", "fill", "tile"]).default("cover"),
    dim: z.number().min(0).max(1).default(0),
  }),
]);
export type Background = z.infer<typeof Background>;

export const WHITE: Background = { kind: "color", color: "#ffffff" };

// ── elements ──────────────────────────────────────────────────────────────

export const TextStyle = z.object({
  fontSize: z.number().positive().max(400).default(32),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  align: z.enum(["left", "center", "right"]).default("left"),
  valign: z.enum(["top", "middle", "bottom"]).default("top"),
  /** Omit to inherit the deck theme's text color. */
  color: Color.optional(),
  /** Omit to inherit the deck theme's font. */
  fontFamily: z.string().optional(),
  lineHeight: z.number().positive().max(4).default(1.25),
});
export type TextStyle = z.infer<typeof TextStyle>;

const Box = {
  id: z.uuid(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Degrees, clockwise. */
  rotation: z.number().default(0),
  locked: z.boolean().default(false),
};

/**
 * `role` marks an element as a layout placeholder ("Click to add Title").
 * Applying a layout replaces elements by role and leaves free-floating ones
 * alone, so switching layouts never eats content the user placed by hand.
 */
export const PlaceholderRole = z.enum(["title", "body", "none"]);
export type PlaceholderRole = z.infer<typeof PlaceholderRole>;

export const TextElement = z.object({
  ...Box,
  kind: z.literal("text"),
  text: z.string().default(""),
  // `.prefault` not `.default`: `.default({})` would store the bare `{}` as-is
  // without ever applying TextStyle's own field defaults, leaving renderers
  // with an undefined fontSize. `.prefault` substitutes then parses.
  style: TextStyle.prefault({}),
  role: PlaceholderRole.default("none"),
});

export const ImageElement = z.object({
  ...Box,
  kind: z.literal("image"),
  /** Relative to the deck's own directory, e.g. `assets/cover.png`. */
  src: z.string().min(1),
  fit: z.enum(["contain", "cover", "fill"]).default("contain"),
  caption: z.string().optional(),
});

export const ShapeElement = z.object({
  ...Box,
  kind: z.literal("shape"),
  shape: z.enum(["rect", "roundRect", "ellipse", "line", "arrow"]).default("rect"),
  fill: Color.optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().nonnegative().max(64).default(0),
});

/**
 * Deliberately narrow: fontSize, color and line height only. Bold, italic and
 * a chosen font family are all in `TextStyle` because they suit prose; on a
 * tab diagram they actively break it — italic skews character widths, most
 * "bold" faces are wider than regular, and a proportional font ends the
 * vertical alignment between string lines entirely. `fontFamily` isn't a
 * field here because it isn't a choice: rendering always forces a monospace
 * stack, which is a technical requirement of the format, not a style.
 */
export const TabStyle = z.object({
  fontSize: z.number().positive().max(200).default(20),
  /** Omit to inherit the deck theme's text color. */
  color: Color.optional(),
  lineHeight: z.number().positive().max(4).default(1.3),
  valign: z.enum(["top", "middle", "bottom"]).default("top"),
});
export type TabStyle = z.infer<typeof TabStyle>;

/**
 * Guitar/bass tab notation, placed verbatim — never generated or parsed.
 * Purely a visualization: nothing here plays it back or understands it as
 * music, matching the rest of the app's "no musical inference" rule.
 */
export const TabElement = z.object({
  ...Box,
  kind: z.literal("tab"),
  text: z.string().default(""),
  style: TabStyle.prefault({}),
});

export const SlideElement = z.discriminatedUnion("kind", [
  TextElement,
  ImageElement,
  ShapeElement,
  TabElement,
]);
export type SlideElement = z.infer<typeof SlideElement>;
export type TextElement = z.infer<typeof TextElement>;
export type ImageElement = z.infer<typeof ImageElement>;
export type ShapeElement = z.infer<typeof ShapeElement>;
export type TabElement = z.infer<typeof TabElement>;
export type ShapeKind = ShapeElement["shape"];
export type ElementKind = SlideElement["kind"];

// ── slides ────────────────────────────────────────────────────────────────

export const LayoutId = z.enum([
  "blank",
  "title",
  "titleContent",
  "titleTwoContent",
  "centered",
  "contentOnly",
]);
export type LayoutId = z.infer<typeof LayoutId>;

export const Slide = z.object({
  id: z.uuid(),
  name: z.string().default("Slide"),
  layout: LayoutId.default("titleContent"),
  /** Overrides the deck theme's background for this slide only. */
  background: Background.optional(),
  elements: z.array(SlideElement).default([]),
  /** Speaker notes. Not shown on the slide. */
  notes: z.string().optional(),
  /**
   * Seconds into the deck's audio at which this slide comes up. Undefined
   * means "not cued" — the slide only appears via manual navigation, and
   * auto-advance skips over it. This is the whole music-sync feature.
   */
  startTime: z.number().nonnegative().optional(),
  /**
   * The chart's lyric lines for this section, stored at chord import so later re-cueing can align them.
   * They duplicate the lyric rows inside the slide's tab text and go stale if that is hand-edited — accepted, because
   * telling lyric rows from chord rows there is a guess, and a wrong guess misplaces slides where none degrades to music.
   * Optional and additive, as with `DeckAudio.stems`: v2 decks validate unchanged, so no version bump and no migration.
   */
  lyrics: z.array(z.string()).optional(),
});
export type Slide = z.infer<typeof Slide>;

// ── deck ──────────────────────────────────────────────────────────────────

export const Theme = z.object({
  /** The master backdrop every slide inherits unless it overrides it. */
  background: Background.prefault(WHITE),
  text: Color.default("#111827"),
  accent: Color.default("#2563eb"),
  fontFamily: z.string().default("Inter, ui-sans-serif, system-ui, sans-serif"),
  /** Named preset this came from, for highlighting the active template. */
  preset: z.string().default("light"),
});
export type Theme = z.infer<typeof Theme>;

/**
 * The instruments a track can be split into.
 *
 * The first four are what the reliable Demucs model produces; `guitar` and
 * `piano` come from its 6-source variant, which separates worse overall. All
 * six are listed now so adding the 6-stem path later is not a schema change.
 */
export const StemId = z.enum(["drums", "bass", "vocals", "other", "guitar", "piano"]);
export type StemId = z.infer<typeof StemId>;

export const Stem = z.object({
  id: StemId,
  /** Relative to the deck's own directory, e.g. `stems/drums.wav`. */
  path: z.string().min(1),
});
export type Stem = z.infer<typeof Stem>;

export const DeckAudio = z.object({
  /** Relative to the deck's own directory (`audio.mp3`). MP3 for V1. */
  path: z.string().min(1),
  /** Seconds. Filled in once the audio element reports it. */
  duration: z.number().positive().optional(),
  /** Shown in the UI; the filename the user picked. */
  originalName: z.string().optional(),
  /**
   * Separated instrument tracks, when the song has been split.
   *
   * `path` above stays the authoritative full mix — stems are an *addition*,
   * never a replacement, so a deck still plays if separation output is
   * deleted. When stems exist the player uses them instead of the mix (they
   * sum to roughly the same thing, so playing both would double everything).
   *
   * Optional and additive: v2 decks validate unchanged, so no version bump
   * and no migration. Rule #6 exists to keep old files loading; they do.
   */
  stems: z.array(Stem).min(1).optional(),
});
export type DeckAudio = z.infer<typeof DeckAudio>;

export const Deck = z
  .object({
    schemaVersion: z.literal(DECK_SCHEMA_VERSION),
    id: z.uuid(),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    theme: Theme.prefault({}),
    audio: DeckAudio.optional(),
    slides: z.array(Slide).default([]),
    notes: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((deck, ctx) => {
    // Cued slides must run forward in slide order. The presenter walks the
    // deck front-to-back while the clock runs forward; letting slide 5 cue
    // before slide 2 means "the next slide" and "the next cue" disagree, and
    // auto-advance would jump backwards mid-song.
    let lastTime = -1;
    let lastIndex = -1;
    for (const [i, slide] of deck.slides.entries()) {
      if (slide.startTime === undefined) continue;
      if (slide.startTime < lastTime) {
        ctx.addIssue({
          code: "custom",
          message:
            `slide ${i + 1} ("${slide.name}") is cued at ${slide.startTime}s but slide ` +
            `${lastIndex + 1} earlier in the deck is cued at ${lastTime}s — cue times must run forward`,
          path: ["slides", i, "startTime"],
        });
      }
      lastTime = slide.startTime;
      lastIndex = i;
    }

    const seen = new Set<string>();
    for (const [i, slide] of deck.slides.entries()) {
      if (seen.has(slide.id)) {
        ctx.addIssue({ code: "custom", message: "duplicate slide id", path: ["slides", i, "id"] });
      }
      seen.add(slide.id);
    }
  });

export type Deck = z.infer<typeof Deck>;

export const DeckSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  slideCount: z.number().int().nonnegative(),
  hasAudio: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type DeckSummary = z.infer<typeof DeckSummary>;

export function summarizeDeck(deck: Deck): DeckSummary {
  return {
    id: deck.id,
    title: deck.title,
    slideCount: deck.slides.length,
    hasAudio: deck.audio !== undefined,
    updatedAt: deck.updatedAt,
  };
}

// ── cue lookup (the sync engine) ──────────────────────────────────────────

export interface Cue {
  /** Index into `deck.slides`. */
  index: number;
  time: number;
}

/** Cued slides in time order. Build once per deck edit, not per frame. */
export function buildCues(slides: readonly Slide[]): Cue[] {
  const cues: Cue[] = [];
  for (const [index, slide] of slides.entries()) {
    if (slide.startTime !== undefined) cues.push({ index, time: slide.startTime });
  }
  return cues.sort((a, b) => a.time - b.time);
}

/**
 * Index of the slide that should be on screen at time `t`, or null before the
 * first cue. O(log n) — this runs inside a requestAnimationFrame loop.
 */
export function slideIndexAt(cues: readonly Cue[], t: number): number | null {
  let lo = 0;
  let hi = cues.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.time <= t) {
      found = cues[mid]!.index;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** `83.4` -> `"1:23"`. */
export function formatCue(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** `"1:23"`, `"83"`, `"1:23.5"` -> seconds, or null if unparseable. */
export function parseCue(input: string): number | null {
  const text = input.trim();
  if (text === "") return null;
  const parts = text.split(":");
  if (parts.length > 2) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  const seconds = nums.length === 2 ? nums[0]! * 60 + nums[1]! : nums[0]!;
  return Number.isFinite(seconds) ? seconds : null;
}

// ── construction ──────────────────────────────────────────────────────────

/** v1 stored backgrounds as bare hex strings; v2 wraps them in the Background union. */
function toBackground(value: unknown): unknown {
  return typeof value === "string" ? { kind: "color", color: value } : value;
}

export function migrateDeck(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const deck = data as Record<string, unknown>;

  // v1 -> v2: `background` became a discriminated union so a slide or the deck
  // theme can use a saved image instead of a flat color.
  if (deck.schemaVersion === 1) {
    const theme = deck.theme as Record<string, unknown> | undefined;
    const slides = Array.isArray(deck.slides) ? deck.slides : [];
    return {
      ...deck,
      schemaVersion: 2,
      ...(theme ? { theme: { ...theme, background: toBackground(theme.background) } } : {}),
      slides: slides.map((slide) => {
        if (typeof slide !== "object" || slide === null) return slide;
        const s = slide as Record<string, unknown>;
        return s.background === undefined ? s : { ...s, background: toBackground(s.background) };
      }),
    };
  }

  return deck;
}

export function parseDeck(data: unknown): Deck {
  return Deck.parse(migrateDeck(data));
}

export function safeParseDeck(data: unknown) {
  return Deck.safeParse(migrateDeck(data));
}

export function newDeck(init: { id: string; title: string; theme?: Partial<Theme> }): Deck {
  const now = new Date().toISOString();
  return Deck.parse({
    schemaVersion: DECK_SCHEMA_VERSION,
    id: init.id,
    title: init.title,
    theme: init.theme ?? {},
    slides: [],
    createdAt: now,
    updatedAt: now,
  });
}
