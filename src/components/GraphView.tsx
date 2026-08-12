import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type EdgeSingular, type NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useGraphStore } from "../store/graphStore.js";
import { useLibraryStore } from "../store/libraryStore.js";
import { topKPerNode, type GraphEdge, type GraphNode } from "../graph/index.js";
import { EDGE_TYPE_RANK } from "../graph/types.js";

cytoscape.use(fcose);

const TOP_K = 8;

const EDGE_STYLE: Record<GraphEdge["type"], { color: string; width: number; dashed: boolean; label: string }> = {
  "same-progression": { color: "#10b981", width: 3, dashed: false, label: "same progression" },
  "quality-variant": { color: "#3b82f6", width: 2.5, dashed: false, label: "quality variant" },
  "same-harmonic-loop": { color: "#a78bfa", width: 2, dashed: true, label: "same harmonic loop" },
  "partial-overlap": { color: "#737373", width: 1.5, dashed: true, label: "partial overlap" },
};

type Selection =
  | { kind: "node"; node: GraphNode; edges: GraphEdge[] }
  | { kind: "edge"; edge: GraphEdge; a: GraphNode; b: GraphNode };

/**
 * The harmonic graph: sections as nodes, typed edges from the taxonomy.
 * Built fresh from the library on demand — this is index data, never
 * persisted (hard rule #2). Rendering prunes to the top-k edges per node
 * (see graph/index.ts) so a progression shared across half the library
 * doesn't turn into an unreadable hairball.
 */
export function GraphView({ onBack }: { onBack: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const index = useGraphStore((s) => s.index);
  const loading = useGraphStore((s) => s.loading);
  const error = useGraphStore((s) => s.error);
  const build = useGraphStore((s) => s.build);
  const openSong = useLibraryStore((s) => s.openSong);

  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    void build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    if (index) for (const n of index.nodes) map.set(n.id, n);
    return map;
  }, [index]);

  const prunedEdges = useMemo(
    () => (index ? topKPerNode(index.edges, TOP_K) : []),
    [index],
  );

  useEffect(() => {
    if (!containerRef.current || !index) return;
    setSelection(null);

    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...index.nodes.map((n) => ({
          data: { id: n.id, label: `${n.sectionName}`, song: n.songTitle, type: n.sectionType },
        })),
        ...prunedEdges.map((e) => ({
          data: { id: `${e.a}→${e.b}→${e.type}`, source: e.a, target: e.b, edgeType: e.type },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#059669",
            label: "data(label)",
            color: "#e5e5e5",
            "font-size": 9,
            "text-valign": "bottom",
            "text-margin-y": 4,
            width: 14,
            height: 14,
            "border-width": 1,
            "border-color": "#0a0a0a",
          },
        },
        {
          selector: "node:selected",
          style: { "background-color": "#f59e0b", "border-color": "#f59e0b" },
        },
        ...(Object.entries(EDGE_STYLE) as [GraphEdge["type"], (typeof EDGE_STYLE)[GraphEdge["type"]]][]).map(
          ([type, s]) => ({
            selector: `edge[edgeType = "${type}"]`,
            style: {
              width: s.width,
              "line-color": s.color,
              "line-style": s.dashed ? ("dashed" as const) : ("solid" as const),
              "curve-style": "haystack" as const,
              opacity: 0.7,
            },
          }),
        ),
        {
          selector: "edge:selected",
          style: { opacity: 1, width: 4 },
        },
      ],
      layout: {
        name: "fcose",
        animate: false,
        nodeRepulsion: 8000,
        idealEdgeLength: 80,
        quality: "default",
      } as unknown as cytoscape.LayoutOptions,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (evt) => {
      const target = evt.target as NodeSingular;
      const node = nodesById.get(target.id());
      if (!node) return;
      const edges = index.edges
        .filter((e) => e.a === node.id || e.b === node.id)
        .sort((x, y) => EDGE_TYPE_RANK[y.type] - EDGE_TYPE_RANK[x.type] || y.weight - x.weight);
      setSelection({ kind: "node", node, edges });
    });

    cy.on("tap", "edge", (evt) => {
      const target = evt.target as EdgeSingular;
      const data = target.data() as { source: string; target: string; edgeType: GraphEdge["type"] };
      const edge = index.edges.find(
        (e) =>
          e.type === data.edgeType &&
          ((e.a === data.source && e.b === data.target) || (e.a === data.target && e.b === data.source)),
      );
      const a = nodesById.get(data.source);
      const b = nodesById.get(data.target);
      if (edge && a && b) setSelection({ kind: "edge", edge, a, b });
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelection(null);
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [index, prunedEdges, nodesById]);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <button onClick={onBack} className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Library
        </button>
        <h1 className="text-lg font-semibold text-neutral-100">Harmonic graph</h1>
        <button
          onClick={() => void build()}
          disabled={loading}
          className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 disabled:opacity-40"
        >
          {loading ? "Building…" : "Rebuild"}
        </button>
      </div>

      <div className="relative flex-1">
        {error && (
          <p className="absolute left-4 top-4 z-10 rounded border border-red-900 bg-red-950/80 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        {index && index.nodes.length === 0 && !loading && (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            No sections with a progression yet — add chords to a section to see it here.
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />

        <div className="absolute bottom-4 left-4 flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950/90 p-2 text-xs text-neutral-400">
          {(Object.entries(EDGE_STYLE) as [GraphEdge["type"], (typeof EDGE_STYLE)[GraphEdge["type"]]][]).map(
            ([type, s]) => (
              <div key={type} className="flex items-center gap-2">
                <span
                  className="inline-block h-0.5 w-4"
                  style={{ backgroundColor: s.color, opacity: 0.8 }}
                />
                {s.label}
              </div>
            ),
          )}
        </div>

        {selection && (
          <div className="absolute right-4 top-4 w-80 max-h-[calc(100%-2rem)] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950/95 p-4 text-sm">
            {selection.kind === "node" ? (
              <>
                <h2 className="font-semibold text-neutral-100">{selection.node.sectionName}</h2>
                <p className="text-xs text-neutral-500">{selection.node.songTitle}</p>
                <p className="mt-2 text-xs text-neutral-400">{selection.node.romanNumerals.join(" – ")}</p>
                <button
                  onClick={() => void openSong(selection.node.songId)}
                  className="mt-3 rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white"
                >
                  Open song
                </button>
                <h3 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Connections ({selection.edges.length})
                </h3>
                <ul className="space-y-2">
                  {selection.edges.map((e, i) => {
                    const other = nodesById.get(e.a === selection.node.id ? e.b : e.a);
                    return (
                      <li key={i} className="border-t border-neutral-800 pt-2">
                        <div className="flex items-center justify-between">
                          <span style={{ color: EDGE_STYLE[e.type].color }} className="text-xs font-medium">
                            {EDGE_STYLE[e.type].label}
                          </span>
                          <span className="text-xs text-neutral-500">{other?.songTitle}</span>
                        </div>
                        <p className="mt-1 text-xs text-neutral-400">{e.detail}</p>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <>
                <h2 className="font-semibold" style={{ color: EDGE_STYLE[selection.edge.type].color }}>
                  {EDGE_STYLE[selection.edge.type].label}
                </h2>
                <p className="mt-2 text-xs text-neutral-400">{selection.edge.detail}</p>
                <div className="mt-3 space-y-2">
                  {[selection.a, selection.b].map((n) => (
                    <div key={n.id} className="rounded border border-neutral-800 p-2">
                      <p className="text-xs font-medium text-neutral-200">{n.sectionName}</p>
                      <p className="text-xs text-neutral-500">{n.songTitle}</p>
                      <button
                        onClick={() => void openSong(n.songId)}
                        className="mt-1 text-xs text-emerald-500 hover:text-emerald-400"
                      >
                        Open →
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
