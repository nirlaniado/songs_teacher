import { z } from "zod";
import { LayoutId } from "../schema/deck.js";

const HexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

const ElementFrame = {
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  rotation: z.number().optional(),
  locked: z.boolean().optional(),
};

const AgentTextStyle = z.object({
  fontSize: z.number().positive().max(400).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  color: HexColor.optional(),
  fontFamily: z.string().optional(),
  lineHeight: z.number().positive().max(4).optional(),
});

/**
 * The agent's operation vocabulary — the single contract every part of the
 * feature agrees on.
 *
 * The deterministic parser produces these. An LLM provider (Codex CLI, or a
 * user-supplied key) produces the *same* shape, validated by the *same* Zod
 * schema. Preview, validation, apply, undo and the tests all consume only
 * this. Adding a new producer must never require touching anything
 * downstream — that is the whole point of routing everything through one
 * typed op list rather than letting each provider drive the store directly.
 *
 * Scope is deliberately narrow (structure + text + cues). The agent operates
 * the app; it never reads or infers musical content. "add chords C D E F"
 * places that literal text — nothing here parses a chord.
 */

/**
 * How an op picks the slides it acts on. Shared by every op so targeting is
 * written and tested once.
 */
export const Target = z.discriminatedUnion("by", [
  /** Explicit 0-based positions in the deck. */
  z.object({ by: z.literal("index"), indexes: z.array(z.number().int().nonnegative()).min(1) }),
  /**
   * Every slide whose name *contains* `pattern`, case-insensitively. Used for
   * free-text references the parser can't resolve to a known section.
   */
  z.object({ by: z.literal("name"), pattern: z.string().min(1) }),
  /**
   * Every slide in a section family, matched on the whole name with any
   * trailing number stripped. Distinct from `name` because substring matching
   * would make "chorus" also select "Pre-Chorus" — which is a different
   * section, and silently editing it would be exactly the kind of misfire the
   * preview exists to prevent.
   */
  z.object({ by: z.literal("family"), base: z.string().min(1) }),
  /**
   * The nth slides matching a base name, in deck order — "verses 1 2 3"
   * becomes `{ base: "verse", ordinals: [1, 2, 3] }`. Ordinals count only
   * matching slides, so anything between them (a chorus, a bridge) is
   * skipped rather than throwing the count off.
   */
  z.object({
    by: z.literal("nameOrdinal"),
    base: z.string().min(1),
    ordinals: z.array(z.number().int().positive()).min(1),
  }),
  z.object({ by: z.literal("all") }),
  /** Whatever slide the editor is currently showing. */
  z.object({ by: z.literal("current") }),
]);
export type Target = z.infer<typeof Target>;

/** One slide to create. `body` is optional starting text for the content frame. */
export const NewSlideSpec = z.object({
  /** Text shown in the slide's title frame. */
  title: z.string(),
  /**
   * The slide's name in the rail and for name-based targeting. Defaults to
   * `title`. They differ when a section slide carries its own heading —
   * "create intro saying Until The End" names the slide "Intro" (so
   * "the intro" still targets it) while the title frame reads "Until The End".
   */
  name: z.string().optional(),
  layout: LayoutId.optional(),
  body: z.string().optional(),
});
export type NewSlideSpec = z.infer<typeof NewSlideSpec>;

export const Op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("createSlides"),
    slides: z.array(NewSlideSpec).min(1),
    /** Insert position; appended to the end when omitted. */
    at: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("setTitle"), target: Target, text: z.string() }),
  z.object({ op: z.literal("setBody"), target: Target, text: z.string() }),
  /** Adds a line to the content frame, preserving what's already there. */
  z.object({ op: z.literal("appendBody"), target: Target, text: z.string() }),
  z.object({ op: z.literal("setNotes"), target: Target, text: z.string() }),
  z.object({ op: z.literal("renameSlide"), target: Target, name: z.string().min(1) }),
  z.object({ op: z.literal("setLayout"), target: Target, layout: LayoutId }),
  z.object({
    op: z.literal("moveSlide"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  z.object({ op: z.literal("deleteSlides"), target: Target }),
  z.object({ op: z.literal("setCue"), target: Target, seconds: z.number().nonnegative() }),
  z.object({ op: z.literal("clearCue"), target: Target }),

  // ── design ────────────────────────────────────────────────────────────
  /**
   * Deck-wide look. `preset` names one of the built-in themes; the individual
   * colour fields override whatever the preset set, so "dark theme but orange
   * accent" is one op rather than two.
   */
  z.object({
    op: z.literal("setTheme"),
    preset: z.string().optional(),
    background: HexColor.optional(),
    text: HexColor.optional(),
    accent: HexColor.optional(),
    fontFamily: z.string().optional(),
  }),
  /**
   * Per-slide backdrop. Colours only from the agent — an image backdrop needs
   * a file the user uploads, which no instruction can conjure.
   */
  z.object({ op: z.literal("setSlideBackground"), target: Target, color: HexColor }),
  /** Reverts targeted slides to the deck-wide backdrop. */
  z.object({ op: z.literal("clearSlideBackground"), target: Target }),
  /**
   * Places an image that is **already stored** in the deck's assets.
   *
   * `src` is a deck-relative path, not a URL — whatever puts the file there
   * (the MCP server downloading cover art, the editor's image button) does so
   * before emitting this. The operation only records the resulting path.
   */
  z.object({
    op: z.literal("addImage"),
    target: Target,
    src: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    fit: z.enum(["contain", "cover", "fill"]).optional(),
  }),
  /** Creates a free-floating text box, independent of layout placeholders. */
  z.object({
    op: z.literal("addTextBox"),
    target: Target,
    text: z.string(),
    ...ElementFrame,
    style: AgentTextStyle.optional(),
  }),
  z.object({
    op: z.literal("addShape"),
    target: Target,
    shape: z.enum(["rect", "roundRect", "ellipse", "line", "arrow"]),
    ...ElementFrame,
    fill: HexColor.optional(),
    stroke: HexColor.optional(),
    strokeWidth: z.number().nonnegative().max(64).optional(),
  }),
  /** Moves, resizes, rotates, or locks existing elements by their stable ids. */
  z.object({
    op: z.literal("updateElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    ...ElementFrame,
  }),
  z.object({
    op: z.literal("setElementText"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    text: z.string(),
    mode: z.enum(["set", "append"]).optional(),
  }),
  z.object({
    op: z.literal("styleElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    style: AgentTextStyle,
  }),
  z.object({
    op: z.literal("updateShapes"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    shape: z.enum(["rect", "roundRect", "ellipse", "line", "arrow"]).optional(),
    fill: HexColor.nullable().optional(),
    stroke: HexColor.nullable().optional(),
    strokeWidth: z.number().nonnegative().max(64).optional(),
  }),
  z.object({
    op: z.literal("updateImages"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    src: z.string().min(1).optional(),
    fit: z.enum(["contain", "cover", "fill"]).optional(),
    caption: z.string().nullable().optional(),
  }),
  z.object({
    op: z.literal("duplicateElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  }),
  z.object({
    op: z.literal("alignElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
    align: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
    relativeTo: z.enum(["selection", "slide"]).optional(),
  }),
  z.object({
    op: z.literal("distributeElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(3),
    axis: z.enum(["horizontal", "vertical"]),
  }),
  z.object({
    op: z.literal("deleteElements"),
    target: Target,
    elementIds: z.array(z.uuid()).min(1),
  }),
  z.object({
    op: z.literal("reorderElement"),
    target: Target,
    elementId: z.uuid(),
    direction: z.enum(["front", "back", "forward", "backward"]),
  }),
  /** Text styling on a slide's title or body frame. */
  z.object({
    op: z.literal("styleText"),
    target: Target,
    role: z.enum(["title", "body", "all"]).default("all"),
    fontSize: z.number().positive().max(400).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    color: HexColor.optional(),
  }),
]);
export type Op = z.infer<typeof Op>;
export type OpKind = Op["op"];

export const OpList = z.array(Op);

/**
 * What a model may reply with.
 *
 * Either the edits, or a request to look a song up first. Letting the model
 * ask replaces the brittle regex intent-detection that preceded it: phrasing,
 * typos, compound sentences and where the title sits are all things a model
 * reads correctly and a pattern cannot. It also means one round trip at most,
 * because `lookup` is answered and the model is asked once more.
 */
export const ModelReply = z.object({
  ops: z.array(Op).optional(),
  message: z.string().optional(),
  lookup: z
    .object({
      /** Just the song, ideally "title artist" — no command words. */
      query: z.string().min(1),
      /** Shown to the user so an unexpected search is visible, not silent. */
      reason: z.string().optional(),
    })
    .optional(),
});
export type ModelReply = z.infer<typeof ModelReply>;

/** Ops the preview must visually flag before the user commits to them. */
const DESTRUCTIVE: ReadonlySet<OpKind> = new Set<OpKind>(["deleteSlides", "deleteElements"]);

export function isDestructive(op: Op): boolean {
  return DESTRUCTIVE.has(op.op);
}

/** What a provider returns: either ops to preview, or a reason it couldn't. */
export type AgentResult =
  | { ok: true; ops: Op[]; message?: string }
  /**
   * The provider understood the request but needs a song looked up before it
   * can produce edits. The caller performs the search and asks again with the
   * outcome — one round trip, never a loop.
   */
  | { ok: false; reason: "needs-lookup"; query: string; message: string }
  | { ok: false; reason: "unparsed" | "empty" | "error"; message: string };

export function unparsed(message: string): AgentResult {
  return { ok: false, reason: "unparsed", message };
}

/** A provider asking for a song lookup before it can produce edits. */
export function needsLookup(query: string, reason?: string): AgentResult {
  return { ok: false, reason: "needs-lookup", query, ...(reason ? { message: reason } : { message: "" }) };
}
