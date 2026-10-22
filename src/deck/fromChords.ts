import type { ChordLine, ChordResult } from "../ug/types.js";
import type { Slide, SlideElement, TextElement } from "../schema/deck.js";
import { applyLayout } from "./templates.js";

/**
 * Turns a chord chart extracted by the Ultimate Guitar agent into a Deck's
 * worth of slides: one cover slide plus one slide per song section.
 *
 * Each section slide shows the chords with the lyrics under them. This
 * function never sets `startTime` and attaches no audio: a chord chart carries
 * no timing, so cues come from analysing the song (see audio/autoCue.ts), and
 * the teacher can still fix any of them in the Music Sync panel.
 */

/** Label for chord lines that fall outside any `[section]` heading. */
const UNLABELLED_SECTION = "Chords";

function isTitleText(el: SlideElement): el is TextElement {
  return el.kind === "text" && el.role === "title";
}

function isBodyText(el: SlideElement): el is TextElement {
  return el.kind === "text" && el.role === "body";
}

/** The cover slide: song title, artist, and whichever of key/capo/tuning are known. */
function coverSlide(result: ChordResult, newId: () => string): Slide {
  const elements = applyLayout([], "centered", newId).map((el) =>
    isTitleText(el) ? { ...el, text: result.source.title } : el,
  );
  const meta = [
    result.key !== null ? `Key: ${result.key}` : null,
    result.capo !== null ? `Capo: ${result.capo}` : null,
    result.tuning !== null ? `Tuning: ${result.tuning}` : null,
  ].filter((line): line is string => line !== null);
  const bodyText = meta.length > 0 ? `${result.source.artist}\n${meta.join(" · ")}` : result.source.artist;

  return {
    id: newId(),
    name: "Title",
    layout: "centered",
    elements: elements.map((el) => (isBodyText(el) ? { ...el, text: bodyText } : el)),
  };
}

interface SectionGroup {
  /** Raw `ChordLine.section`, before disambiguation — `null` for an unheaded run. */
  section: string | null;
  lines: ChordLine[];
}

/**
 * Groups consecutive lines that share a section heading (including runs
 * where the heading is `null`) into one group per slide. A song's `Verse 1 /
 * Chorus / Verse 2 / Chorus` stays four groups in song order, not two merged
 * by name.
 */
function groupSections(lines: readonly ChordLine[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (const line of lines) {
    const current = groups[groups.length - 1];
    if (current && current.section === line.section) {
      current.lines.push(line);
    } else {
      groups.push({ section: line.section, lines: [line] });
    }
  }
  return groups;
}

interface LabelledGroup {
  label: string;
  lines: ChordLine[];
}

/**
 * Resolves each group's display label, suffixing repeats in the order they
 * occur (`"Chorus (1)"`, `"Chorus (2)"`) so a song with a section heading
 * used more than once still gets distinctly named slides; a label used once
 * stays bare.
 */
function labelGroups(groups: readonly SectionGroup[]): LabelledGroup[] {
  const rawLabels = groups.map((g) => g.section ?? UNLABELLED_SECTION);
  const totals = new Map<string, number>();
  for (const label of rawLabels) totals.set(label, (totals.get(label) ?? 0) + 1);

  const seen = new Map<string, number>();
  return groups.map((group, i) => {
    const raw = rawLabels[i]!;
    if ((totals.get(raw) ?? 0) <= 1) return { label: raw, lines: group.lines };
    const occurrence = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, occurrence);
    return { label: `${raw} (${occurrence})`, lines: group.lines };
  });
}

/**
 * One slide per section: the label as the title, and the section's chords as
 * a `TabElement` (not `TextElement`) in the body frame. Chords sit in a row
 * above their lyric and must stay column-aligned with it — `TextElement`'s
 * `pre-wrap` would reflow it at the box edge and break that alignment, where
 * `TabElement` forces monospace + `pre` for precisely this reason.
 */
function sectionSlide(group: LabelledGroup, newId: () => string): Slide {
  const elements = applyLayout([], "titleContent", newId).map((el) =>
    isTitleText(el) ? { ...el, text: group.label } : el,
  );
  const body = elements.find(isBodyText);
  // The chord row keeps its original spacing so each chord sits over the words it belongs to.
  const chordText = group.lines.flatMap((line) => (line.lyric ? [line.row, line.lyric] : [line.row])).join("\n");
  const tab: SlideElement = {
    kind: "tab",
    id: newId(),
    x: body?.x ?? 0,
    y: body?.y ?? 0,
    w: body?.w ?? 1,
    h: body?.h ?? 1,
    rotation: body?.rotation ?? 0,
    locked: body?.locked ?? false,
    text: chordText,
    style: { fontSize: 20, lineHeight: 1.3, valign: "top" },
  };

  const lyrics = group.lines.flatMap((line) => (line.lyric ? [line.lyric] : []));
  return {
    id: newId(),
    name: group.label,
    layout: "titleContent",
    elements: [...elements.filter((el) => el !== body), tab],
    ...(lyrics.length > 0 ? { lyrics } : {}),
  };
}

/** Builds the full slide set for a deck generated from an extracted chord chart. */
export function chordDeckSlides(result: ChordResult, newId: () => string): Slide[] {
  const sections = labelGroups(groupSections(result.lines));
  return [coverSlide(result, newId), ...sections.map((group) => sectionSlide(group, newId))];
}

export interface ChordSection {
  name: string;
  /** Chord lines in the section — a rough measure of how long it lasts. */
  lines: number;
  /** The section's lyric lines, in order; empty for the cover and instrumental sections. */
  lyrics: string[];
}

/**
 * The song's structure, one entry per slide in the same order as
 * `chordDeckSlides` (cover first), for timing the deck to the recording.
 */
export function chordSectionPlan(result: ChordResult): ChordSection[] {
  const sections = labelGroups(groupSections(result.lines)).map((group) => ({
    name: group.label,
    lines: group.lines.length,
    lyrics: group.lines.flatMap((line) => (line.lyric ? [line.lyric] : [])),
  }));
  return [{ name: "Title", lines: 0, lyrics: [] }, ...sections];
}
