/**
 * Project model — TypeScript owns this entirely (ADR-002 §7).
 *
 * `project.json` sits *beside* the .odp, never inside it (brief §8). The two
 * files have two owners and are joined only by slide index, which is the whole
 * coupling between the presentation and the music.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;

export interface SlideCue {
  /** 0-based slide index — the only thing shared with LibreOffice. */
  slide: number;
  /** Integer milliseconds. Formatted strings are display-only (brief §10). */
  timeMs: number;
}

export interface Project {
  schemaVersion: number;
  presentation: { document: string };
  audio: { source: string; durationMs: number } | null;
  slideSync: SlideCue[];
  /** Present in the format from V1 so V2/V3 need no migration to start using them. */
  sections: unknown[];
  markers: unknown[];
  guitarTracks: unknown[];
}

export function newProject(document: string, audio: string | null): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    presentation: { document },
    audio: audio ? { source: audio, durationMs: 0 } : null,
    slideSync: [],
    sections: [],
    markers: [],
    guitarTracks: [],
  };
}

/**
 * Every reader migrates before validating (brief §34). Nothing to do at v1,
 * but the seam exists now — retrofitting it after data exists is the hard way.
 */
export function migrate(raw: unknown): Project {
  const p = raw as Project;
  if (typeof p?.schemaVersion !== "number") {
    throw new Error("project.json: missing schemaVersion");
  }
  if (p.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `project.json is schema v${p.schemaVersion}; this build understands v${SCHEMA_VERSION}`,
    );
  }
  return p;
}

export async function load(dir: string): Promise<Project> {
  return migrate(JSON.parse(await readFile(join(dir, "project.json"), "utf8")));
}

/**
 * Atomic save (brief §35): temp file + rename. A plain overwrite truncates
 * first, so a crash mid-write leaves a shorter file with the old tail still
 * attached — corrupt JSON. Observed in the previous project, not theoretical.
 */
export async function save(dir: string, project: Project): Promise<void> {
  const target = join(dir, "project.json");
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(project, null, 2), "utf8");
  await rename(tmp, target);
}

// ---- schedule resolution -------------------------------------------------

/**
 * Which slide is due at `timeMs`.
 *
 * A pure function of (cues, time) with no state and no I/O — which is exactly
 * what lets the browser run the identical logic locally on every animation
 * frame without asking the server (ADR-002 §9). Shared, not reimplemented.
 *
 * Returns -1 before the first cue, so "nothing scheduled yet" is representable
 * rather than silently showing slide 0.
 */
export function slideAt(cues: readonly SlideCue[], timeMs: number): number {
  const ordered = [...cues].sort((a, b) => a.timeMs - b.timeMs);
  let current = -1;
  for (const cue of ordered) {
    if (cue.timeMs <= timeMs) current = cue.slide;
    else break;
  }
  return current;
}

/**
 * Cues must run forward through the deck: the schedule assumes one active
 * slide and a forward-running clock, and a backwards cue would make the deck
 * jump backwards mid-song.
 */
export function validateCues(cues: readonly SlideCue[]): string | null {
  const bySlide = [...cues].sort((a, b) => a.slide - b.slide);
  for (let i = 1; i < bySlide.length; i++) {
    if (bySlide[i]!.timeMs < bySlide[i - 1]!.timeMs) {
      return `slide ${bySlide[i]!.slide} is cued before slide ${bySlide[i - 1]!.slide}`;
    }
  }
  return null;
}
