import { useEffect, useMemo, useRef, useState } from "react";
import { type Cue, slideIndexAt } from "../../schema/deck.js";
import { audioUrl, slideUrl, type SlideCue } from "../../lok/client.js";
import { useLokPlayer } from "../../lok/useLokPlayer.js";

/**
 * Fullscreen presentation for the LOK-backed editor — plays the track,
 * follows the deck along via `slideIndexAt` (reused from `src/schema/deck.ts`
 * as-is; cue resolution is generic over `{index, time}` and has nothing
 * `Deck`-specific about it). The rules this follows are the ones CLAUDE.md
 * documents as hard-won for the existing `PresentMode`, applied here too:
 *
 * - **Auto-advance yields to the presenter.** An arrow key sets `manual` and
 *   the clock stops moving the slide until "Following music" is pressed.
 * - **Uncued slides are skipped by the clock, not unreachable** — arrow keys
 *   walk every slide by index; only the audio-driven path uses `slideSync`.
 * - **`AudioContext`/`<audio>` autoplay needs a user gesture** — no
 *   autoplay attempt on mount; a "Click to start" overlay is the only way
 *   playback begins, same fallback shape `PresentMode` already uses.
 */
export interface LokPresentModeProps {
  slideNames: string[];
  slideSync: SlideCue[];
  revision: number[];
  hasAudio: boolean;
  onExit: () => void;
}

export function LokPresentMode({
  slideNames,
  slideSync,
  revision,
  hasAudio,
  onExit,
}: LokPresentModeProps) {
  const player = useLokPlayer(hasAudio ? audioUrl() : null);
  const [manual, setManual] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const manualRef = useRef(false);
  manualRef.current = manual;

  const cues = useMemo<Cue[]>(
    () => slideSync.map((c) => ({ index: c.slide, time: c.timeMs / 1000 })),
    [slideSync],
  );

  useEffect(() => {
    player.onTick((t) => {
      if (manualRef.current) return;
      const idx = slideIndexAt(cues, t);
      if (idx !== null) setCurrentSlide(idx);
    });
    return () => player.onTick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onExit();
        return;
      }
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setManual(true);
        setCurrentSlide((i) => Math.min(i + 1, slideNames.length - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setManual(true);
        setCurrentSlide((i) => Math.max(i - 1, 0));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, slideNames.length]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <img
        src={slideUrl(currentSlide, revision[currentSlide] ?? 0)}
        alt={slideNames[currentSlide]}
        className="max-h-full max-w-full"
      />

      {hasAudio && !player.playing && (
        <button
          onClick={() => void player.play()}
          className="absolute inset-0 flex items-center justify-center bg-black/60 text-xl text-white"
        >
          ▶ Click to start
        </button>
      )}

      {manual && (
        <button
          onClick={() => setManual(false)}
          className="absolute bottom-4 right-4 rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Following music
        </button>
      )}

      <button
        onClick={onExit}
        className="absolute top-4 right-4 text-sm text-white/50 hover:text-white"
      >
        Esc to exit
      </button>
    </div>
  );
}
