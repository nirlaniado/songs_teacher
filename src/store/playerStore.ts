import { create } from "zustand";
import { sectionAt, type Section } from "../schema/song.js";

/**
 * Playback clock, kept out of React's render loop.
 *
 * `currentTime` still lives here (it has to live *somewhere* readable), but per
 * the project's own trap list ("don't put currentTime in React state... hold it
 * in a store with selective subscription") the fix is not to avoid the store —
 * it's to make sure only the one component that renders a live time readout
 * (e.g. the transport clock) selects `currentTime` itself. Everything else,
 * notably the slide view, selects `activeSectionId`, which only changes a few
 * times a minute. Zustand only re-renders a component when its *selected*
 * slice changes identity, so this single store serves both cadences safely.
 *
 * `tick()` is driven by a requestAnimationFrame loop (see usePlaybackClock),
 * never by the audio element's `timeupdate` event — timeupdate fires ~4x/sec,
 * which is visibly late for slide swaps synced to a beat.
 */

interface PlayerState {
  sections: readonly Section[];
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  loopEnabled: boolean;
  /** Section under the playhead right now, or explicitly selected in the sidebar. */
  activeSectionId: string | null;
  /** Sidebar selection can pin a section independent of playback for editing. */
  selectedSectionId: string | null;
  /**
   * Imperative bridge to the WaveSurfer instance, registered by the Waveform
   * component that owns it. Transport controls (play/pause, seek) live
   * outside that component, so they go through this rather than every
   * consumer reaching for a ref that might not be mounted yet.
   */
  transport: { playPause(): void; seek(t: number): void } | null;
  setTransport(transport: PlayerState["transport"]): void;

  setSections(sections: readonly Section[]): void;
  setPlaying(playing: boolean): void;
  setDuration(duration: number): void;
  setLoopEnabled(on: boolean): void;
  selectSection(id: string | null): void;
  /** Called once per animation frame with the audio element's current time. */
  tick(t: number): void;
  reset(): void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  sections: [],
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  loopEnabled: false,
  activeSectionId: null,
  selectedSectionId: null,
  transport: null,

  setTransport(transport) {
    set({ transport });
  },
  setSections(sections) {
    set({ sections });
  },
  setPlaying(playing) {
    set({ isPlaying: playing });
  },
  setDuration(duration) {
    set({ duration });
  },
  setLoopEnabled(on) {
    set({ loopEnabled: on });
  },
  selectSection(id) {
    set({ selectedSectionId: id });
  },
  tick(t) {
    const { sections, activeSectionId } = get();
    const active = sectionAt(sections, t);
    const nextActiveId = active?.id ?? null;
    if (nextActiveId !== activeSectionId) {
      set({ currentTime: t, activeSectionId: nextActiveId });
    } else {
      set({ currentTime: t });
    }
  },
  reset() {
    set({
      sections: [],
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      loopEnabled: false,
      activeSectionId: null,
      selectedSectionId: null,
      transport: null,
    });
  },
}));

/** The section the playhead is currently inside, or null in a gap. */
export function activeSection(state: PlayerState): Section | null {
  return state.sections.find((s) => s.id === state.activeSectionId) ?? null;
}

/** The section shown in the editor: sidebar selection wins, else playback position. */
export function editorSection(state: PlayerState): Section | null {
  const id = state.selectedSectionId ?? state.activeSectionId;
  return state.sections.find((s) => s.id === id) ?? null;
}
