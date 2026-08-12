import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import TimelinePlugin from "wavesurfer.js/plugins/timeline";
import { useLibraryStore } from "../store/libraryStore.js";
import { usePlayerStore } from "../store/playerStore.js";
import { SECTION_TYPE_COLOR as TYPE_COLOR } from "./sectionColors.js";

/**
 * WaveSurfer + Regions, driving section creation, editing, and the playback
 * clock. This is the one place that owns a WaveSurfer instance.
 *
 * Marking a section is drag-to-select on empty waveform (one gesture instead
 * of separate in/out taps) — regions.enableDragSelection covers "tap-to-mark"
 * more directly than a two-tap flow would, since the drag itself sets both
 * boundaries. Existing regions can be dragged and resized to adjust bounds,
 * clicked to select/seek, and double-clicked to delete.
 */
export function Waveform({ audioUrl }: { audioUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Region ids that already correspond to a real section, vs. an in-flight drag preview. */
  const knownIdsRef = useRef<Set<string>>(new Set());

  const sections = useLibraryStore((s) => s.currentSong?.sections ?? []);
  const addSection = useLibraryStore((s) => s.addSection);
  const removeSection = useLibraryStore((s) => s.removeSection);
  const updateSection = useLibraryStore((s) => s.updateSection);
  const setAudioDuration = useLibraryStore((s) => s.setAudioDuration);

  const setSections = usePlayerStore((s) => s.setSections);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const selectSection = usePlayerStore((s) => s.selectSection);
  const tick = usePlayerStore((s) => s.tick);
  const setTransport = usePlayerStore((s) => s.setTransport);

  // Keep the sync engine's view of sections current regardless of playback state.
  useEffect(() => {
    setSections(sections);
  }, [sections, setSections]);

  // ── create the WaveSurfer instance once per audio file ──────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      height: 96,
      waveColor: "#525252",
      progressColor: "#059669",
      cursorColor: "#f59e0b",
      normalize: true,
      dragToSeek: true,
      plugins: [regions, TimelinePlugin.create({ height: 16 })],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    knownIdsRef.current = new Set();

    const disableDrag = regions.enableDragSelection({
      color: "rgba(16, 185, 129, 0.25)",
    });

    function stopClock() {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    function startClock() {
      stopClock();
      const step = () => {
        const t = ws.getCurrentTime();
        tick(t);
        // Loop-section: read live state rather than a closured value, since
        // this callback is created once per audio load, not per render.
        const { loopEnabled, activeSectionId, sections: live } = usePlayerStore.getState();
        if (loopEnabled && activeSectionId) {
          const active = live.find((s) => s.id === activeSectionId);
          if (active && t >= active.end) {
            ws.setTime(active.start);
          }
        }
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    }

    setTransport({
      playPause: () => void ws.playPause(),
      seek: (t) => {
        ws.setTime(t);
        tick(t);
      },
    });

    ws.on("ready", (duration) => {
      setDuration(duration);
      setAudioDuration(duration);
      tick(0);
    });
    ws.on("play", () => {
      setPlaying(true);
      startClock();
    });
    ws.on("pause", () => {
      setPlaying(false);
      stopClock();
      tick(ws.getCurrentTime());
    });
    ws.on("finish", () => {
      setPlaying(false);
      stopClock();
      tick(ws.getCurrentTime());
    });
    // Click-to-seek and drag-the-cursor while paused: one clock update, not a loop.
    ws.on("interaction", (newTime) => tick(newTime));
    ws.on("seeking", (newTime) => tick(newTime));

    regions.on("region-created", (region) => {
      if (knownIdsRef.current.has(region.id)) return; // ours, from the sync effect below
      // A fresh drag on empty waveform: create the real section, then drop
      // this ad-hoc region — the sync effect repaints it with the real id,
      // name, and type color once the store updates.
      addSection(region.start, region.end);
      region.remove();
    });

    regions.on("region-updated", (region) => {
      if (!knownIdsRef.current.has(region.id)) return;
      updateSection(region.id, (s) => ({ ...s, start: region.start, end: region.end }));
    });

    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      if (!knownIdsRef.current.has(region.id)) return;
      selectSection(region.id);
      ws.setTime(region.start);
      tick(region.start);
    });

    regions.on("region-double-clicked", (region, e) => {
      e.stopPropagation();
      if (!knownIdsRef.current.has(region.id)) return;
      if (confirm("Delete this section?")) removeSection(region.id);
    });

    return () => {
      stopClock();
      disableDrag();
      setTransport(null);
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
    // audioUrl identifies the track; re-create the whole instance when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // ── repaint regions whenever the underlying sections change ─────────────
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    const ids = new Set(sections.map((s) => s.id));
    knownIdsRef.current = ids;
    regions.clearRegions();
    for (const section of sections) {
      regions.addRegion({
        id: section.id,
        start: section.start,
        end: section.end,
        content: section.name,
        color: TYPE_COLOR[section.type],
        drag: true,
        resize: true,
      });
    }
  }, [sections]);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div ref={containerRef} />
      <p className="mt-2 text-xs text-neutral-600">
        Drag on empty waveform to mark a section. Drag a region's edges to resize, click to
        jump to it, double-click to delete.
      </p>
    </div>
  );
}

export type { Region };
