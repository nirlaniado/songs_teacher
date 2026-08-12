import type { KeyRef, SectionType } from "../schema/song.js";

/**
 * Strongest match wins, in this order — each type is defined as "matches at
 * this level and fails every stronger one" (see the planned edge taxonomy in
 * CLAUDE.md / README.md). That keeps a single strong match from also drawing
 * as three weaker ones.
 */
export const EDGE_TYPES = [
  "same-progression",
  "quality-variant",
  "same-harmonic-loop",
  "partial-overlap",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Higher = stronger. Used to rank mixed-type edges for top-k pruning. */
export const EDGE_TYPE_RANK: Record<EdgeType, number> = {
  "same-progression": 4,
  "quality-variant": 3,
  "same-harmonic-loop": 2,
  "partial-overlap": 1,
};

export interface GraphNode {
  id: string; // section id
  songId: string;
  songTitle: string;
  sectionName: string;
  sectionType: SectionType;
  key: KeyRef;
  progression: readonly string[];
  /** Derived (or `section.romanNumerals` override), one per chord; "?" where unparseable. */
  romanNumerals: readonly string[];
}

export interface GraphEdge {
  a: string; // section id
  b: string; // section id
  type: EdgeType;
  /** Semitones between the two sections' keys. Only set for "same-progression". */
  transposition?: number;
  /** Length of the shared run. Only set for "partial-overlap". */
  overlapLength?: number;
  /** IDF weight of the shared n-gram, for ranking/pruning "partial-overlap" edges. Higher = rarer = more meaningful. */
  weight: number;
  /** Human-readable explanation for the "why are these related?" panel. */
  detail: string;
}

export interface GraphIndex {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
