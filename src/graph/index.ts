import { Note } from "tonal";
import type { KeyRef, Section, Song } from "../schema/song.js";
import { effectiveKey } from "../schema/song.js";
import { romanNumeralsFor, skeletonOf } from "../theory/roman.js";
import { sameCanonicalRotation } from "../theory/rotation.js";
import { longestCommonRun, ngrams } from "../theory/ngrams.js";
import { EDGE_TYPE_RANK, type GraphEdge, type GraphIndex, type GraphNode } from "./types.js";

export * from "./types.js";

/**
 * Builds the harmonic graph from a scanned library. Pure and rebuildable —
 * nothing here is persisted (hard rule #2): re-run this whenever the matching
 * algorithm changes, or the library does.
 *
 * `better-sqlite3` was the decided index store, but it's a native module the
 * stack table itself scopes to "Electron phase" — it can't load in a browser
 * tab. This is the browser-compatible substitute: an in-memory index rebuilt
 * on demand, same shape, swappable for a SQLite-backed one without changing
 * any caller.
 */

const MIN_NGRAM = 4;
const numeralKey = (n: string) => n;

function semitonesBetween(a: KeyRef, b: KeyRef): number {
  return (Note.chroma(b.tonic) - Note.chroma(a.tonic) + 12) % 12;
}

function sameSequence(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function buildNode(song: Song, section: Section): GraphNode {
  const key = effectiveKey(song, section);
  const romanNumerals = section.romanNumerals
    ? [...section.romanNumerals]
    : romanNumeralsFor(section.progression, key).map((n) => n ?? "?");
  return {
    id: section.id,
    songId: song.id,
    songTitle: song.title,
    sectionName: section.name,
    sectionType: section.type,
    key,
    progression: section.progression,
    romanNumerals,
  };
}

/** Document frequency of every n-gram (n >= MIN_NGRAM) across the corpus, for IDF weighting. */
function buildNgramCorpus(nodes: readonly GraphNode[]): Map<string, Set<string>> {
  const df = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (let n = MIN_NGRAM; n <= node.romanNumerals.length; n++) {
      for (const gram of ngrams(node.romanNumerals, n)) {
        // length-prefixed so a length-4 and length-5 gram never collide
        const gramKey = `${n}:${gram.join("␟")}`;
        let docs = df.get(gramKey);
        if (!docs) {
          docs = new Set();
          df.set(gramKey, docs);
        }
        docs.add(node.id);
      }
    }
  }
  return df;
}

function matchPair(
  a: GraphNode,
  b: GraphNode,
  idfOf: (gram: readonly string[]) => number,
): GraphEdge | null {
  // 1. Same Progression — identical roman numerals, same order.
  if (sameSequence(a.romanNumerals, b.romanNumerals)) {
    const transposition = semitonesBetween(a.key, b.key);
    return {
      a: a.id,
      b: b.id,
      type: "same-progression",
      transposition,
      weight: 1,
      detail:
        `Both play ${a.romanNumerals.join("-")}` +
        (transposition === 0
          ? " in the same key — same fingerings."
          : `, ${transposition} semitone${transposition === 1 ? "" : "s"} apart.`),
    };
  }

  // 2. Quality Variant — same skeleton, same order, different chord qualities.
  const skeletonA = a.romanNumerals.map(skeletonOf);
  const skeletonB = b.romanNumerals.map(skeletonOf);
  if (sameSequence(skeletonA, skeletonB)) {
    return {
      a: a.id,
      b: b.id,
      type: "quality-variant",
      weight: 1,
      detail: `Same skeleton (${skeletonA.join("-")}), different qualities: "${a.romanNumerals.join(
        "-",
      )}" vs "${b.romanNumerals.join("-")}".`,
    };
  }

  // 3. Same Harmonic Loop — canonical rotation matches; original order does not.
  if (sameCanonicalRotation(a.romanNumerals, b.romanNumerals, numeralKey)) {
    return {
      a: a.id,
      b: b.id,
      type: "same-harmonic-loop",
      weight: 1,
      detail: `Same loop, different entry point: "${a.romanNumerals.join("-")}" vs "${b.romanNumerals.join(
        "-",
      )}".`,
    };
  }

  // 4. Partial Overlap — shared contiguous run >= MIN_NGRAM, IDF-weighted.
  const run = longestCommonRun(a.romanNumerals, b.romanNumerals, numeralKey, MIN_NGRAM);
  if (run) {
    return {
      a: a.id,
      b: b.id,
      type: "partial-overlap",
      overlapLength: run.length,
      weight: idfOf(run.ngram),
      detail: `Share a ${run.length}-chord run: ${run.ngram.join("-")}.`,
    };
  }

  return null;
}

export function buildGraphIndex(songs: readonly Song[]): GraphIndex {
  const nodes: GraphNode[] = [];
  for (const song of songs) {
    for (const section of song.sections) {
      if (section.progression.length === 0) continue; // nothing to match on
      nodes.push(buildNode(song, section));
    }
  }

  const corpus = buildNgramCorpus(nodes);
  const totalNodes = nodes.length;
  const idfOf = (gram: readonly string[]): number => {
    const gramKey = `${gram.length}:${gram.join("␟")}`;
    const docFreq = corpus.get(gramKey)?.size ?? 1;
    // +1 smoothing: a gram this function is asked about always occurs at least once.
    return Math.log((totalNodes + 1) / (docFreq + 1));
  };

  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const edge = matchPair(nodes[i]!, nodes[j]!, idfOf);
      if (edge) edges.push(edge);
    }
  }

  return { nodes, edges };
}

/**
 * Keep only the top `k` edges touching each node (by type strength, then
 * weight), unioned across both endpoints. A progression that recurs across
 * 60% of the library is noise; this is the second half of controlling it
 * alongside IDF (see README's "Planned edge taxonomy").
 */
export function topKPerNode(edges: readonly GraphEdge[], k: number): GraphEdge[] {
  const byNode = new Map<string, GraphEdge[]>();
  const attach = (id: string, edge: GraphEdge) => {
    const list = byNode.get(id);
    if (list) list.push(edge);
    else byNode.set(id, [edge]);
  };
  for (const edge of edges) {
    attach(edge.a, edge);
    attach(edge.b, edge);
  }

  const strength = (edge: GraphEdge) => EDGE_TYPE_RANK[edge.type] * 1e6 + edge.weight;
  const kept = new Set<GraphEdge>();
  for (const list of byNode.values()) {
    const top = [...list].sort((x, y) => strength(y) - strength(x)).slice(0, k);
    for (const edge of top) kept.add(edge);
  }
  return edges.filter((edge) => kept.has(edge));
}
