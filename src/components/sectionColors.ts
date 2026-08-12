import type { SectionType } from "../schema/song.js";

/** Color by section type, shared by every timeline UI (waveform regions, cue strips). */
export const SECTION_TYPE_COLOR: Record<SectionType, string> = {
  intro: "rgba(148, 163, 184, 0.35)",
  verse: "rgba(59, 130, 246, 0.35)",
  "pre-chorus": "rgba(167, 139, 250, 0.35)",
  chorus: "rgba(16, 185, 129, 0.35)",
  "post-chorus": "rgba(52, 211, 153, 0.35)",
  bridge: "rgba(244, 114, 182, 0.35)",
  solo: "rgba(251, 146, 60, 0.35)",
  instrumental: "rgba(234, 179, 8, 0.35)",
  breakdown: "rgba(239, 68, 68, 0.35)",
  outro: "rgba(148, 163, 184, 0.35)",
  other: "rgba(115, 115, 115, 0.35)",
};
