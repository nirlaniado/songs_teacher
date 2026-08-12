import {
  LayoutId,
  SLIDE_H,
  SLIDE_W,
  type SlideElement,
  type Theme,
} from "../schema/deck.js";

/**
 * Layouts and themes — the "Layouts" and "Master Slide" panels in Impress.
 *
 * A layout is a *generator* of placeholder elements, not a stored mode. Once
 * applied, the slide holds plain elements the user can move and resize freely;
 * `slide.layout` is only remembered so the panel can show which one is active
 * and so re-applying is idempotent. This is why switching layouts can preserve
 * text: we match old placeholders to new ones by `role`.
 */

const M = 64; // outer margin
const TITLE_H = 120;

export interface LayoutDef {
  id: LayoutId;
  label: string;
  /** Placeholder frames this layout provides, in z-order. */
  frames(): Array<Omit<Extract<SlideElement, { kind: "text" }>, "id"> & { id?: string }>;
}

function textFrame(
  role: "title" | "body",
  x: number,
  y: number,
  w: number,
  h: number,
  overrides: Partial<{ fontSize: number; align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom"; bold: boolean }> = {},
) {
  const isTitle = role === "title";
  return {
    kind: "text" as const,
    x,
    y,
    w,
    h,
    rotation: 0,
    locked: false,
    text: "",
    role,
    style: {
      fontSize: overrides.fontSize ?? (isTitle ? 54 : 28),
      bold: overrides.bold ?? isTitle,
      italic: false,
      underline: false,
      align: overrides.align ?? "left",
      valign: overrides.valign ?? (isTitle ? "middle" : "top"),
      lineHeight: 1.25,
    },
  };
}

export const LAYOUTS: LayoutDef[] = [
  {
    id: "blank",
    label: "Blank",
    frames: () => [],
  },
  {
    id: "title",
    label: "Title only",
    frames: () => [textFrame("title", M, M, SLIDE_W - M * 2, TITLE_H)],
  },
  {
    id: "titleContent",
    label: "Title, content",
    frames: () => [
      textFrame("title", M, M, SLIDE_W - M * 2, TITLE_H),
      textFrame("body", M, M + TITLE_H + 24, SLIDE_W - M * 2, SLIDE_H - M * 2 - TITLE_H - 24),
    ],
  },
  {
    id: "titleTwoContent",
    label: "Title, two columns",
    frames: () => {
      const top = M + TITLE_H + 24;
      const h = SLIDE_H - M * 2 - TITLE_H - 24;
      const w = (SLIDE_W - M * 2 - 32) / 2;
      return [
        textFrame("title", M, M, SLIDE_W - M * 2, TITLE_H),
        textFrame("body", M, top, w, h),
        textFrame("body", M + w + 32, top, w, h),
      ];
    },
  },
  {
    id: "centered",
    label: "Centered title",
    frames: () => [
      textFrame("title", M, SLIDE_H / 2 - 110, SLIDE_W - M * 2, 130, {
        align: "center",
        valign: "bottom",
        fontSize: 64,
      }),
      textFrame("body", M, SLIDE_H / 2 + 30, SLIDE_W - M * 2, 90, {
        align: "center",
        valign: "top",
        fontSize: 30,
      }),
    ],
  },
  {
    id: "contentOnly",
    label: "Content only",
    frames: () => [textFrame("body", M, M, SLIDE_W - M * 2, SLIDE_H - M * 2)],
  },
];

export function layoutById(id: LayoutId): LayoutDef {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0]!;
}

/**
 * Rebuild a slide's elements for `layout`, carrying text across by role so
 * changing layout doesn't wipe what was typed. Non-placeholder elements
 * (role "none" — anything the user inserted themselves) pass through
 * untouched.
 */
export function applyLayout(
  existing: readonly SlideElement[],
  layout: LayoutId,
  newId: () => string,
): SlideElement[] {
  const freeform = existing.filter((el) => el.kind !== "text" || el.role === "none");
  const oldTitles = existing.filter(
    (el): el is Extract<SlideElement, { kind: "text" }> => el.kind === "text" && el.role === "title",
  );
  const oldBodies = existing.filter(
    (el): el is Extract<SlideElement, { kind: "text" }> => el.kind === "text" && el.role === "body",
  );

  let titleCursor = 0;
  let bodyCursor = 0;
  const placeholders = layoutById(layout)
    .frames()
    .map((frame) => {
      const source = frame.role === "title" ? oldTitles[titleCursor++] : oldBodies[bodyCursor++];
      return {
        ...frame,
        id: newId(),
        text: source?.text ?? "",
      } as SlideElement;
    });

  return [...placeholders, ...freeform];
}

// ── themes ────────────────────────────────────────────────────────────────

export interface ThemePreset extends Theme {
  label: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    label: "Light",
    preset: "light",
    background: { kind: "color", color: "#ffffff" },
    text: "#111827",
    accent: "#2563eb",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  {
    label: "Dark",
    preset: "dark",
    background: { kind: "color", color: "#0f172a" },
    text: "#f1f5f9",
    accent: "#38bdf8",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  {
    label: "Warm paper",
    preset: "paper",
    background: { kind: "color", color: "#faf5eb" },
    text: "#3b2f2f",
    accent: "#b45309",
    fontFamily: "Georgia, 'Times New Roman', serif",
  },
  {
    label: "Chalkboard",
    preset: "chalk",
    background: { kind: "color", color: "#1c2b27" },
    text: "#e8f5e9",
    accent: "#7dd3a0",
    fontFamily: "'Courier New', ui-monospace, monospace",
  },
  {
    label: "Deep purple",
    preset: "purple",
    background: { kind: "color", color: "#2e1065" },
    text: "#f5f3ff",
    accent: "#c4b5fd",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
];

// ── tab scaffolds ────────────────────────────────────────────────────────

/**
 * A tuning's six open-string names, high to low (string 1 to string 6) — the
 * order a tab diagram is conventionally read top to bottom.
 *
 * Static reference data, not inference: these are the standard names for
 * named tunings, same status as `THEME_PRESETS`. Nothing here listens to
 * audio or derives a tuning from anything — the user picks one from a list.
 */
export interface TuningPreset {
  id: string;
  label: string;
  /** High string first, matching `strings` order and tab-diagram reading order. */
  strings: readonly [string, string, string, string, string, string];
}

export const TUNING_PRESETS: TuningPreset[] = [
  { id: "standard", label: "Standard (E A D G B E)", strings: ["e", "B", "G", "D", "A", "E"] },
  {
    id: "half-down",
    label: "Half step down (Eb Ab Db Gb Bb Eb)",
    strings: ["eb", "Bb", "Gb", "Db", "Ab", "Eb"],
  },
  {
    id: "half-up",
    label: "Half step up (F Bb Eb Ab C F)",
    strings: ["f", "C", "Ab", "Eb", "Bb", "F"],
  },
  { id: "drop-d", label: "Drop D (D A D G B E)", strings: ["e", "B", "G", "D", "A", "D"] },
  { id: "drop-c", label: "Drop C (C G C F A D)", strings: ["d", "A", "F", "C", "G", "C"] },
  {
    id: "drop-csharp",
    label: "Drop C# (C# G# C# F# A# D#)",
    strings: ["d#", "A#", "F#", "C#", "G#", "D#"],
  },
];

export function tuningById(id: string): TuningPreset {
  return TUNING_PRESETS.find((t) => t.id === id) ?? TUNING_PRESETS[0]!;
}

/** How many dashes follow each string label — extend by typing more. */
const TAB_SCAFFOLD_WIDTH = 7;

/**
 * A blank scaffold for a new tab element: one labelled, dash-filled line per
 * string, in the given tuning. Bare structure, not musical content — the
 * labels name open strings, and the dashes carry no notes until the user
 * replaces some with fret numbers.
 */
export function tabScaffold(tuning: TuningPreset): string {
  return tuning.strings.map((label) => `${label}|${"-".repeat(TAB_SCAFFOLD_WIDTH)}`).join("\n");
}

/**
 * Pads every line to the length of the longest, with trailing dashes, so a
 * hand-edited tab forms a clean rectangle instead of a ragged right edge —
 * editing one string's line naturally leaves the others short.
 *
 * Only ever appends dashes; nothing already in a line is touched, so this
 * can't move or reinterpret a fret number that's already there.
 */
export function padTabLines(text: string): string {
  const lines = text.split("\n");
  const width = Math.max(0, ...lines.map((line) => line.length));
  return lines.map((line) => line + "-".repeat(width - line.length)).join("\n");
}

/** Starter content so a brand-new deck isn't a blank void. */
export function starterSlides(newId: () => string, title: string): SlideElement[][] {
  const titleSlide = applyLayout([], "centered", newId).map((el) =>
    el.kind === "text" && el.role === "title" ? { ...el, text: title } : el,
  );
  return [titleSlide];
}
