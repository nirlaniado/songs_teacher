import { LayoutId, parseCue, type Deck } from "../../schema/deck.js";
import { LAYOUTS } from "../../deck/templates.js";
import { unparsed, type AgentResult, type Op, type Target } from "../ops.js";
import { canonicalFor, normalizeWords, parseSectionRun, titlesFor } from "./sections.js";

/**
 * The deterministic command parser — the default engine.
 *
 * Free, instant, offline, and needs no account, which is why it runs first
 * and why the common instructions are shaped to land here rather than at an
 * LLM. Anything it doesn't recognise returns `unparsed` so a language
 * provider can take over when one is configured.
 *
 * Rules are tried in order and the first match wins, so more specific
 * patterns are listed before more general ones.
 */

const CREATE = /^(?:create|add|make|new|build|generate)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:slides?\s+(?:for\s+)?)?(.+)$/i;

/**
 * "create intro saying Until The End under it band: …" — one slide plus its
 * text, which is how people actually dictate a slide. The head before the
 * keyword names the slide; everything after is its content.
 */
const CREATE_WITH_TEXT =
  /^(?:create|add|make|new|build)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:slides?\s+(?:for\s+|called\s+)?)?(.+?)\s+(?:saying|that says|which says|titled|called|with the text|with text|showing)\s+(.+)$/i;

/**
 * Splits stacked lines: "X under it Y". Bare "under"/"below" are deliberately
 * not accepted — they appear inside ordinary text ("the bridge under the
 * chorus") and would split content the user meant to keep together.
 */
const UNDER = /\s+(?:and\s+)?(?:underneath|under\s+(?:it|that|this)|below\s+(?:it|that|this))\s+/i;
const CUE = /^(?:cue|time|sync|set)\s+(?:the\s+)?(.+?)\s+(?:at|to)\s+([\d:.]+)\s*$/i;
const CLEAR_CUE = /^(?:clear|remove|delete)\s+(?:the\s+)?cue\s+(?:from|on|for)\s+(?:the\s+)?(.+)$/i;
const ADD_TEXT = /^(?:add|write|put|append|set)\s+(.+?)\s+(?:to|on|in|for)\s+(?:the\s+)?(.+)$/i;
const RENAME = /^rename\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/i;
const LAYOUT = /^(?:make|set|use|apply)\s+(?:the\s+)?(.+?)\s+(?:a|as|to|use|with)\s+(.+?)\s*(?:layout)?$/i;
const DELETE = /^(?:delete|remove|drop)\s+(?:the\s+)?(.+)$/i;
// "these" throughout, because the canvas supports multi-selection and
// "delete these" is what people type once they have one.
const ROTATE_SELECTED = /^rotate\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?(?:\s+by)?\s+(-?\d+(?:\.\d+)?)\s*(?:degrees?|°)?$/i;
const LOCK_SELECTED = /^(lock|unlock)\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?$/i;
const ORDER_SELECTED = /^(?:bring|move|send)\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?\s+(?:to\s+the\s+)?(front|back|forward|backward)$/i;
const DUPLICATE_SELECTED = /^(?:duplicate|copy)\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?$/i;
const DELETE_SELECTED = /^(?:delete|remove)\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?|\s+shapes?|\s+images?|\s+text(?:\s+box(?:es)?)?)?$/i;
/** "align these left", "align the selected elements to the middle". */
const ALIGN_SELECTED =
  /^align\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?\s+(?:to\s+the\s+)?(left|center|centre|right|top|middle|bottom)$/i;
/** "distribute these horizontally" — Impress's Shape ▸ Distribute. */
const DISTRIBUTE_SELECTED =
  /^(?:distribute|space)\s+(?:the\s+)?(?:selected|this|these)(?:\s+elements?|\s+objects?)?\s+(horizontally|vertically|across|down)$/i;
const ADD_SHAPE = /^add\s+(?:(red|orange|yellow|green|blue|purple|black|white)\s+)?(rectangle|rounded rectangle|circle|ellipse|line|arrow)\s+(?:to|on)\s+(?:the\s+)?(.+)$/i;

const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  black: "#000000",
  white: "#ffffff",
};

/** Strips a leading verb-ish noise word so "chords C D E F" yields "C D E F". */
const CONTENT_PREFIX = /^(?:chords?|lyrics?|text|line|notes?|words?)\s*:?\s+/i;

/**
 * Reads a slide reference: "verses 1 2 3", "the chorus", "slide 2",
 * "slides 2-4", "all slides", "this slide".
 */
export function parseTarget(text: string): Target | null {
  // Ranges are checked against lightly-normalized text that still has its
  // hyphen — `normalizeWords` strips punctuation, which would turn
  // "slides 2-4" into "slides 2 4" and read it as two separate slides.
  const loose = text.toLowerCase().replace(/\s+/g, " ").trim();
  const range = loose.match(/^(?:the\s+)?slides?\s+(\d+)\s*(?:-|–|to|through|thru)\s*(\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo >= 1 && hi >= lo) {
      return { by: "index", indexes: Array.from({ length: hi - lo + 1 }, (_, k) => lo - 1 + k) };
    }
  }

  // Leading articles carry no meaning here but would break family lookup:
  // "the choruses" must resolve the same as "choruses".
  const t = normalizeWords(text).replace(/^(?:the|a|an|all of the|all)\s+/, "");
  if (t === "") return null;

  if (/^(?:all|every|each)(?: slides?| of them)?$/.test(t)) return { by: "all" };
  if (/^(?:this|current|the current)(?: slide)?$/.test(t)) return { by: "current" };
  if (/^slides?$/.test(t)) return { by: "all" };

  const numbered = t.match(/^slides?\s+((?:\d+[\s,and]*)+)$/);
  if (numbered) {
    const nums = numbered[1]!.match(/\d+/g)?.map(Number) ?? [];
    const indexes = nums.filter((n) => n >= 1).map((n) => n - 1);
    if (indexes.length > 0) return { by: "index", indexes };
  }

  // "verses 1 2 3" / "verse 2" — a section family plus ordinals.
  const family = t.match(/^([a-z][a-z\s]*?)\s*((?:\d+[\s,and]*)*)$/);
  if (family) {
    const base = canonicalFor(family[1]!.trim());
    if (base) {
      const nums = family[2]?.match(/\d+/g)?.map(Number) ?? [];
      if (nums.length > 0) return { by: "nameOrdinal", base, ordinals: nums };
      // Bare family name means every slide in it: "add X to the choruses".
      // `family`, not `name` — substring matching would also catch Pre-Chorus.
      return { by: "family", base };
    }
  }

  // Anything else is treated as a literal name fragment.
  return { by: "name", pattern: text.trim() };
}

function parseLayoutName(text: string): LayoutId | null {
  const t = normalizeWords(text);
  const byLabel = LAYOUTS.find((l) => normalizeWords(l.label) === t);
  if (byLabel) return byLabel.id;
  const byId = LayoutId.options.find((id) => normalizeWords(id) === t);
  if (byId) return byId;
  // A few phrasings people actually type.
  if (/^(?:centred|centered)(?: title)?$/.test(t)) return "centered";
  if (/^(?:title only|just a title)$/.test(t)) return "title";
  if (/^(?:two columns?|2 columns?|two content)$/.test(t)) return "titleTwoContent";
  if (/^(?:content only|body only)$/.test(t)) return "contentOnly";
  if (/^(?:blank|empty)$/.test(t)) return "blank";
  if (/^(?:title and content|title content)$/.test(t)) return "titleContent";
  return null;
}

/** A `[Section Name]` header on a line of its own. */
const BLOCK_HEADER = /^\s*\[([^\]]{1,60})\]\s*$/;

/**
 * Splits pasted, section-tagged text into per-slide content:
 *
 *     [Intro]
 *     …your text…
 *
 *     [Verse 1]
 *     …your text…
 *
 * Each block fills the matching slide, or creates one when it doesn't exist
 * yet — the usual way a teacher gets a whole song's worth of material onto a
 * deck in one go. The text is yours; this only distributes what you pasted.
 *
 * Returns null when the input has no headers, so ordinary one-line commands
 * fall through to the normal rules.
 */
function parseSectionBlocks(input: string, deck: Deck): AgentResult | null {
  const lines = input.split(/\r?\n/);
  const blocks: Array<{ name: string; body: string[] }> = [];

  for (const line of lines) {
    const header = BLOCK_HEADER.exec(line);
    if (header) {
      blocks.push({ name: header[1]!.trim(), body: [] });
    } else if (blocks.length > 0) {
      blocks.at(-1)!.body.push(line);
    }
    // Text before the first header is ignored — usually a title line.
  }

  if (blocks.length === 0) return null;

  const ops: Op[] = [];
  for (const block of blocks) {
    const body = block.body.join("\n").trim();
    // Canonicalise so "[chrus]" and "[Chorus]" reach the same slide, while an
    // unrecognised tag keeps whatever the user typed.
    const canonical = canonicalFor(block.name);
    const title = canonical
      ? block.name.replace(/^[a-z\s-]+/i, (m) => (canonicalFor(m.trim()) ? canonical : m))
      : block.name;

    const existing = deck.slides.findIndex(
      (s) => normalizeWords(s.name) === normalizeWords(title),
    );

    if (existing !== -1) {
      ops.push({ op: "setBody", target: { by: "index", indexes: [existing] }, text: body });
    } else {
      // One op per block rather than a single batched create, so the preview
      // reads back in the same order the text was pasted.
      ops.push({
        op: "createSlides",
        slides: [{ title, layout: "titleContent", ...(body ? { body } : {}) }],
      });
    }
  }

  return { ok: true, ops };
}

export function parseCommand(
  input: string,
  deck: Deck,
  selectedElementIds: readonly string[] = [],
): AgentResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty", message: "Type an instruction." };

  // Checked first: pasted content is unambiguous and must never be mistaken
  // for a command.
  const blocks = parseSectionBlocks(input, deck);
  if (blocks) return blocks;

  // ── selected element commands ──────────────────────────────────────────
  // These resolve to a stable id immediately; preview/apply therefore keep
  // referring to the object the user meant even if selection later changes.
  const selectedIds = selectedElementIds.length > 0 ? [...selectedElementIds] : null;
  const current = { by: "current" as const };
  const rotateSelected = ROTATE_SELECTED.exec(text);
  if (rotateSelected && selectedIds) {
    return { ok: true, ops: [{ op: "updateElements", target: current, elementIds: selectedIds, rotation: Number(rotateSelected[1]) }] };
  }
  const lockSelected = LOCK_SELECTED.exec(text);
  if (lockSelected && selectedIds) {
    return { ok: true, ops: [{ op: "updateElements", target: current, elementIds: selectedIds, locked: lockSelected[1]!.toLowerCase() === "lock" }] };
  }
  const orderSelected = ORDER_SELECTED.exec(text);
  if (orderSelected && selectedIds) {
    const direction = orderSelected[1]!.toLowerCase() as "front" | "back" | "forward" | "backward";
    // `reorderElement` moves one element, so a multi-selection becomes one op
    // each. Ordered so the whole block keeps its relative stacking: moving
    // towards the front, the topmost must be dealt with last.
    const order = direction === "front" || direction === "forward" ? selectedIds : [...selectedIds].reverse();
    return {
      ok: true,
      ops: order.map((elementId) => ({ op: "reorderElement", target: current, elementId, direction })),
    };
  }
  if (DUPLICATE_SELECTED.test(text) && selectedIds) {
    return { ok: true, ops: [{ op: "duplicateElements", target: current, elementIds: selectedIds }] };
  }
  if (DELETE_SELECTED.test(text) && selectedIds) {
    return { ok: true, ops: [{ op: "deleteElements", target: current, elementIds: selectedIds }] };
  }
  const alignSelected = ALIGN_SELECTED.exec(text);
  if (alignSelected && selectedIds) {
    const spelling = alignSelected[1]!.toLowerCase();
    const align = (spelling === "centre" ? "center" : spelling) as
      | "left" | "center" | "right" | "top" | "middle" | "bottom";
    // Same rule the editor applies: several elements align to each other, one
    // aligns to the slide — otherwise "centre it" on a lone shape does nothing.
    const relativeTo = selectedIds.length > 1 ? "selection" : "slide";
    return { ok: true, ops: [{ op: "alignElements", target: current, elementIds: selectedIds, align, relativeTo }] };
  }
  const distributeSelected = DISTRIBUTE_SELECTED.exec(text);
  if (distributeSelected && selectedIds) {
    const word = distributeSelected[1]!.toLowerCase();
    const axis = word === "vertically" || word === "down" ? "vertical" : "horizontal";
    if (selectedIds.length < 3) {
      return unparsed("Select at least three elements to distribute — two are just the ends.");
    }
    return { ok: true, ops: [{ op: "distributeElements", target: current, elementIds: selectedIds, axis }] };
  }
  if (
    !selectedIds &&
    (rotateSelected ||
      lockSelected ||
      orderSelected ||
      alignSelected ||
      distributeSelected ||
      DUPLICATE_SELECTED.test(text) ||
      DELETE_SELECTED.test(text))
  ) {
    return unparsed("Select an element on the slide first, then try that command again.");
  }

  // ── basic shape creation ───────────────────────────────────────────────
  const addShape = ADD_SHAPE.exec(text);
  if (addShape) {
    const target = parseTarget(addShape[3]!);
    if (target) {
      const name = addShape[2]!.toLowerCase();
      const shape = name === "rectangle" ? "rect" : name === "rounded rectangle" ? "roundRect" : name === "circle" ? "ellipse" : name as "ellipse" | "line" | "arrow";
      const color = addShape[1] ? NAMED_COLORS[addShape[1].toLowerCase()] : undefined;
      return { ok: true, ops: [{ op: "addShape", target, shape, ...(color ? { fill: color } : {}) }] };
    }
  }

  // ── clear a cue ────────────────────────────────────────────────────────
  const clearCue = CLEAR_CUE.exec(text);
  if (clearCue) {
    const target = parseTarget(clearCue[1]!);
    if (target) return { ok: true, ops: [{ op: "clearCue", target }] };
  }

  // ── set a cue: "cue the chorus at 2:22" ────────────────────────────────
  const cue = CUE.exec(text);
  if (cue) {
    const seconds = parseCue(cue[2]!);
    const target = parseTarget(cue[1]!);
    if (seconds !== null && target) {
      return { ok: true, ops: [{ op: "setCue", target, seconds }] };
    }
    if (seconds === null) {
      return unparsed(`I couldn't read "${cue[2]}" as a time. Try 2:22 or 142.`);
    }
  }

  // ── rename ─────────────────────────────────────────────────────────────
  const rename = RENAME.exec(text);
  if (rename) {
    const target = parseTarget(rename[1]!);
    const name = rename[2]!.trim();
    if (target && name) return { ok: true, ops: [{ op: "renameSlide", target, name }] };
  }

  // ── layout: "make the intro a centered title" ──────────────────────────
  const layout = LAYOUT.exec(text);
  if (layout) {
    const id = parseLayoutName(layout[2]!);
    const target = parseTarget(layout[1]!);
    if (id && target) return { ok: true, ops: [{ op: "setLayout", target, layout: id }] };
  }

  // ── content: "add chords C D E F to verses 1 2 3" ──────────────────────
  // Checked before `create` because "add X to Y" is content, not structure.
  const addText = ADD_TEXT.exec(text);
  if (addText) {
    const target = parseTarget(addText[2]!);
    const payload = addText[1]!.replace(CONTENT_PREFIX, "").trim();
    if (target && payload) {
      const replace = /^set\b/i.test(text);
      return {
        ok: true,
        ops: [{ op: replace ? "setBody" : "appendBody", target, text: payload }],
      };
    }
  }

  // ── one slide with its text: "create intro saying X under it Y" ────────
  // Before the plain structure rule, which would reject the trailing prose.
  const withText = CREATE_WITH_TEXT.exec(text);
  if (withText) {
    const head = withText[1]!.trim();
    const lines = withText[2]!
      .split(UNDER)
      .map((part) => part.trim())
      .filter((part) => part !== "");

    if (lines.length > 0) {
      // A recognised section names the slide ("Intro"), so "the intro" still
      // targets it later while the title frame shows the user's own words.
      // Anything else is taken as a literal name.
      const sections = parseSectionRun(head);
      const name = sections?.length === 1 ? titlesFor(sections)[0]! : head;
      const [title, ...rest] = lines;
      return {
        ok: true,
        ops: [
          {
            op: "createSlides",
            slides: [
              {
                title: title!,
                name,
                layout: "titleContent" as const,
                ...(rest.length > 0 ? { body: rest.join("\n") } : {}),
              },
            ],
          },
        ],
      };
    }
  }

  // ── structure: "create intro verse1 chorus verse2 bridge" ──────────────
  const create = CREATE.exec(text);
  if (create) {
    const sections = parseSectionRun(create[1]!);
    if (sections) {
      const titles = titlesFor(sections);
      return {
        ok: true,
        ops: [
          {
            op: "createSlides",
            slides: titles.map((title) => ({
              title,
              // A section slide is a heading plus room for chords and notes.
              layout: "titleContent" as const,
            })),
          },
        ],
      };
    }
  }

  // ── delete ─────────────────────────────────────────────────────────────
  const del = DELETE.exec(text);
  if (del) {
    const target = parseTarget(del[1]!);
    if (target) return { ok: true, ops: [{ op: "deleteSlides", target }] };
  }

  void deck; // reserved: future rules may disambiguate against current slides
  return unparsed(
    `I didn't understand that. Try: "create intro verse 1 chorus verse 2", ` +
      `"add chords C D E F to verses 1 2 3", or "cue the chorus at 2:22".`,
  );
}

/** Shown in the panel as a starting point. */
export const EXAMPLE_COMMANDS = [
  "create intro verse1 pre hook chorus verse2 bridge chorus verse3",
  "add chords C D E F to verses 1 2 3",
  "cue the chorus at 2:22",
  "make the intro a centered title",
  "rename slide 1 to Opening",
];
