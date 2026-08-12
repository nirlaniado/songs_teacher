import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, Song, type KeyRef } from "../schema/song.js";
import { buildGraphIndex, topKPerNode } from "./index.js";
import type { GraphEdge } from "./types.js";

/**
 * Fixtures set `section.romanNumerals` directly (the manual-override field)
 * rather than relying on chord-symbol derivation, so these tests isolate
 * edge-typing logic from roman-numeral derivation (covered separately in
 * theory/roman.test.ts). `progression` is still populated because the schema
 * requires it to be at least as long, but its content doesn't matter here.
 */
function song(
  title: string,
  key: KeyRef,
  sections: { name: string; romanNumerals: string[]; key?: KeyRef }[],
): Song {
  let t = 0;
  return Song.parse({
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    title,
    key,
    audio: { path: "audio.mp3" },
    sections: sections.map((s) => {
      const start = t;
      const end = t + 10;
      t = end;
      return {
        id: crypto.randomUUID(),
        name: s.name,
        type: "verse",
        start,
        end,
        ...(s.key ? { key: s.key } : {}),
        progression: s.romanNumerals.map(() => "X"), // placeholder, only length matters
        romanNumerals: s.romanNumerals,
      };
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const C_MAJOR: KeyRef = { tonic: "C", mode: "major" };
const D_MAJOR: KeyRef = { tonic: "D", mode: "major" };

function edgeBetween(edges: readonly GraphEdge[], nameA: string, nameB: string, nodes: { id: string; sectionName: string }[]) {
  const idA = nodes.find((n) => n.sectionName === nameA)!.id;
  const idB = nodes.find((n) => n.sectionName === nameB)!.id;
  return edges.find((e) => (e.a === idA && e.b === idB) || (e.a === idB && e.b === idA));
}

describe("buildGraphIndex", () => {
  it("types an identical progression in the same key as same-progression, transposition 0", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["IV", "I", "V", "vi"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["IV", "I", "V", "vi"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Chorus", nodes);
    expect(edge?.type).toBe("same-progression");
    expect(edge?.transposition).toBe(0);
  });

  it("types an identical progression in a different key as same-progression with the semitone gap", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["IV", "I", "V", "vi"] }]),
      song("B", D_MAJOR, [{ name: "Chorus", romanNumerals: ["IV", "I", "V", "vi"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Chorus", nodes);
    expect(edge?.type).toBe("same-progression");
    expect(edge?.transposition).toBe(2); // C -> D is up a whole step
  });

  it("types a same-skeleton, different-quality progression as quality-variant", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["ii", "V", "I"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["iiø7", "V7", "I"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Chorus", nodes);
    expect(edge?.type).toBe("quality-variant");
  });

  it("types a rotation of the same loop as same-harmonic-loop, not same-progression", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["I", "V", "vi", "IV"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["vi", "IV", "I", "V"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Chorus", nodes);
    expect(edge?.type).toBe("same-harmonic-loop");
  });

  it("types a shared 4+ chord run with no stronger match as partial-overlap", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["I", "vi", "IV", "V", "I", "ii"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["iii", "vi", "IV", "V", "I", "IV"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Chorus", nodes);
    expect(edge?.type).toBe("partial-overlap");
    expect(edge?.overlapLength).toBe(4);
  });

  it("draws no edge below the minimum n-gram length with no stronger match", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["I", "vi", "IV"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["ii", "vi", "IV"] }]),
    ];
    const { edges } = buildGraphIndex(songs);
    expect(edges).toHaveLength(0);
  });

  it("skips sections with an empty progression entirely", () => {
    const songs = [song("A", C_MAJOR, [{ name: "Intro", romanNumerals: [] }])];
    const { nodes } = buildGraphIndex(songs);
    expect(nodes).toHaveLength(0);
  });

  it("respects a section's own key override for transposition", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["i", "VI", "III", "VII"] }]),
      song("B", C_MAJOR, [
        {
          name: "Bridge",
          romanNumerals: ["i", "VI", "III", "VII"],
          key: { tonic: "E", mode: "minor" }, // section key overrides the song's C major
        },
      ]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const edge = edgeBetween(edges, "Verse", "Bridge", nodes);
    expect(edge?.type).toBe("same-progression");
    // A's effective key is C major (song key); B's is E minor (section override).
    expect(edge?.transposition).toBe((4 + 12) % 12); // C -> E is up 4 semitones
  });

  it("gives every pair at most one edge, of the strongest type that applies", () => {
    // A rotation that also happens to share a skeleton is still one edge, not three.
    const songs = [
      song("A", C_MAJOR, [{ name: "Verse", romanNumerals: ["I", "V", "vi", "IV"] }]),
      song("B", C_MAJOR, [{ name: "Chorus", romanNumerals: ["I", "V", "vi", "IV"] }]),
    ];
    const { edges } = buildGraphIndex(songs);
    expect(edges).toHaveLength(1);
  });
});

describe("topKPerNode", () => {
  it("keeps only the k strongest edges touching each node", () => {
    const songs = [
      song("A", C_MAJOR, [{ name: "S1", romanNumerals: ["I", "V", "vi", "IV"] }]),
      song("B", C_MAJOR, [{ name: "S2", romanNumerals: ["I", "V", "vi", "IV"] }]), // same-progression with S1
      song("C", C_MAJOR, [{ name: "S3", romanNumerals: ["vi", "IV", "I", "V"] }]), // same-harmonic-loop with S1
      // S3's own strongest edge is to S3b (same-progression), not to S1 — so
      // the weak S1-S3 edge should be pruned from S3's side too, and not
      // survive via the "kept if either endpoint wants it" union rule.
      song("F", C_MAJOR, [{ name: "S3b", romanNumerals: ["vi", "IV", "I", "V"] }]),
    ];
    const { nodes, edges } = buildGraphIndex(songs);
    const s1 = nodes.find((n) => n.sectionName === "S1")!;
    const pruned = topKPerNode(edges, 1);
    const s1Edges = pruned.filter((e) => e.a === s1.id || e.b === s1.id);
    // S1 has a same-progression edge (to S2) and a weaker same-harmonic-loop
    // edge (to S3); with k=1 only the stronger one should survive.
    expect(s1Edges).toHaveLength(1);
    expect(s1Edges[0]?.type).toBe("same-progression");
  });

  it("keeps an edge if either endpoint ranks it in their own top-k, even if the other endpoint doesn't", () => {
    // Build a hub node with many strong edges, and one weak edge to a leaf
    // whose only connection is that edge — pruning per-node with k=1 must not
    // drop the leaf's sole edge just because the hub has stronger options.
    const hubSongs = Array.from({ length: 3 }, (_, i) =>
      song(`Hub${i}`, C_MAJOR, [{ name: `H${i}`, romanNumerals: ["I", "V", "vi", "IV"] }]),
    );
    const leaf = song("Leaf", C_MAJOR, [{ name: "L", romanNumerals: ["ii", "V", "I"] }]);
    const partner = song("Partner", C_MAJOR, [{ name: "P", romanNumerals: ["iiø7", "V7", "I"] }]);
    const { nodes, edges } = buildGraphIndex([...hubSongs, leaf, partner]);
    const leafNode = nodes.find((n) => n.sectionName === "L")!;
    const pruned = topKPerNode(edges, 1);
    const leafEdges = pruned.filter((e) => e.a === leafNode.id || e.b === leafNode.id);
    expect(leafEdges).toHaveLength(1);
    expect(leafEdges[0]?.type).toBe("quality-variant");
  });
});
