import { formatCue, type Deck } from "../schema/deck.js";
import { layoutById } from "../deck/templates.js";
import { applyOps } from "./apply.js";
import { isDestructive, type Op, type Target } from "./ops.js";
import { namesOf, resolveTarget } from "./targets.js";

/**
 * Renders an op as a sentence for the preview list.
 *
 * The preview is the whole safety mechanism for this feature: the user's only
 * chance to notice a misread instruction is reading these lines, so they name
 * the *actual resolved slides* ("Verse 1, Verse 2, Verse 3") rather than
 * echoing the target expression back. Resolving here means a target that
 * matched nothing is visible as "no matching slides" before anything is
 * applied.
 */

function quote(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, " / ").trim();
  return oneLine.length > 60 ? `"${oneLine.slice(0, 57)}…"` : `"${oneLine}"`;
}

function list(names: string[]): string {
  if (names.length === 0) return "no matching slides";
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

export function describeOp(op: Op, deck: Deck, currentSlide = 0): string {
  const targeted = (t: Target) => list(namesOf(deck, resolveTarget(deck, t, currentSlide)));

  switch (op.op) {
    case "createSlides": {
      // Names and titles can differ ("Intro" holding the heading "Until The
      // End"), so show both when they do — otherwise the preview hides which
      // name the slide will actually answer to for later targeting.
      const labels = op.slides.map((s) => {
        const name = (s.name ?? s.title) || "Untitled";
        const title = s.title.trim();
        const heading = title && title !== name ? ` (${quote(title)})` : "";
        const extra = s.body ? ` +${s.body.split("\n").length} line` : "";
        return `${name}${heading}${extra}`;
      });
      const where = op.at === undefined ? "" : ` at position ${op.at + 1}`;
      return `Create ${labels.length} slide${labels.length === 1 ? "" : "s"}${where}: ${list(labels)}`;
    }
    case "setTitle":
      return `Set title ${quote(op.text)} on ${targeted(op.target)}`;
    case "setBody":
      return `Replace text with ${quote(op.text)} on ${targeted(op.target)}`;
    case "appendBody":
      return `Add ${quote(op.text)} to ${targeted(op.target)}`;
    case "setNotes":
      return `Set speaker notes on ${targeted(op.target)}`;
    case "renameSlide":
      return `Rename ${targeted(op.target)} to ${quote(op.name)}`;
    case "setLayout":
      return `Apply the "${layoutById(op.layout).label}" layout to ${targeted(op.target)}`;
    case "moveSlide":
      return `Move slide ${op.from + 1} to position ${op.to + 1}`;
    case "deleteSlides":
      return `Delete ${targeted(op.target)}`;
    case "setCue":
      return `Cue ${targeted(op.target)} at ${formatCue(op.seconds)}`;
    case "clearCue":
      return `Clear the cue on ${targeted(op.target)}`;

    case "setTheme": {
      const parts: string[] = [];
      if (op.preset) parts.push(`"${op.preset}" theme`);
      if (op.background) parts.push(`background ${op.background}`);
      if (op.text) parts.push(`text ${op.text}`);
      if (op.accent) parts.push(`accent ${op.accent}`);
      if (op.fontFamily) parts.push(`font ${op.fontFamily}`);
      return `Set the deck design: ${parts.join(", ") || "no change"}`;
    }
    case "setSlideBackground":
      return `Set the background of ${targeted(op.target)} to ${op.color}`;
    case "clearSlideBackground":
      return `Reset ${targeted(op.target)} to the deck background`;
    case "addImage":
      return `Place the image ${quote(op.src)} on ${targeted(op.target)}`;
    case "addTextBox":
      return `Add text box ${quote(op.text)} to ${targeted(op.target)}`;
    case "addShape":
      return `Add a ${op.shape} shape to ${targeted(op.target)}`;
    case "updateElements":
      return `Transform ${op.elementIds.length} element${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "setElementText":
      return `${op.mode === "append" ? "Append to" : "Replace text in"} ${op.elementIds.length} element${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "styleElements":
      return `Style ${op.elementIds.length} text element${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "updateShapes":
      return `Update ${op.elementIds.length} shape${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "updateImages":
      return `Update ${op.elementIds.length} image${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "duplicateElements":
      return `Duplicate ${op.elementIds.length} element${op.elementIds.length === 1 ? "" : "s"} on ${targeted(op.target)}`;
    case "alignElements":
      return `Align ${op.elementIds.length} element${op.elementIds.length === 1 ? "" : "s"} ${op.align} on ${targeted(op.target)}`;
    case "distributeElements":
      return `Distribute ${op.elementIds.length} elements ${op.axis}ly on ${targeted(op.target)}`;
    case "deleteElements":
      return `Delete ${op.elementIds.length} element${op.elementIds.length === 1 ? "" : "s"} from ${targeted(op.target)}`;
    case "reorderElement":
      return `Move element ${op.elementId} ${op.direction} on ${targeted(op.target)}`;
    case "styleText": {
      const parts: string[] = [];
      if (op.fontSize) parts.push(`size ${op.fontSize}`);
      if (op.bold !== undefined) parts.push(op.bold ? "bold" : "not bold");
      if (op.italic !== undefined) parts.push(op.italic ? "italic" : "not italic");
      if (op.underline !== undefined) parts.push(op.underline ? "underlined" : "not underlined");
      if (op.align) parts.push(`aligned ${op.align}`);
      if (op.color) parts.push(`colour ${op.color}`);
      const scope = op.role === "all" ? "text" : `${op.role} text`;
      return `Make the ${scope} on ${targeted(op.target)} ${parts.join(", ") || "unchanged"}`;
    }
  }
}

/**
 * Describes a whole batch, folding the deck forward between ops.
 *
 * Each op is described against the deck *as it will be when that op runs*,
 * not against the starting deck. Without this, "create Verse 1, then add
 * chords to Verse 1" previews the second line as "no matching slides" —
 * telling the user nothing will happen when in fact it will. Ops routinely
 * depend on earlier ones, so describing them all against the initial state
 * is actively misleading.
 */
export function describeOps(
  deck: Deck,
  ops: readonly Op[],
  currentSlide = 0,
): Array<{ text: string; destructive: boolean; empty: boolean }> {
  let current = deck;
  const lines: Array<{ text: string; destructive: boolean; empty: boolean }> = [];
  for (const op of ops) {
    lines.push({
      text: describeOp(op, current, currentSlide),
      destructive: isDestructive(op),
      empty: opIsEmpty(op, current, currentSlide),
    });
    current = applyOps(current, [op], currentSlide).deck;
  }
  return lines;
}

/** True when the op would touch nothing, so the preview can warn instead of no-op'ing. */
export function opIsEmpty(op: Op, deck: Deck, currentSlide = 0): boolean {
  // Deck-wide ops always apply; the rest touch nothing if their target
  // resolves to no slides, which the preview flags rather than silently
  // doing nothing.
  if (!("target" in op)) return false;
  const indexes = resolveTarget(deck, op.target, currentSlide);
  if (indexes.length === 0) return true;
  if (
    op.op === "updateElements" ||
    op.op === "setElementText" ||
    op.op === "styleElements" ||
    op.op === "updateShapes" ||
    op.op === "updateImages" ||
    op.op === "duplicateElements" ||
    op.op === "alignElements" ||
    op.op === "distributeElements" ||
    op.op === "deleteElements"
  ) {
    const ids = new Set(op.elementIds);
    return !indexes.some((i) => deck.slides[i]?.elements.some((el) => ids.has(el.id)));
  }
  if (op.op === "reorderElement") {
    return !indexes.some((i) => deck.slides[i]?.elements.some((el) => el.id === op.elementId));
  }
  return false;
}
