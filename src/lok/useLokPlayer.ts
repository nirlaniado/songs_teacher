import { useCallback, useEffect, useRef, useState } from "react";
import { createElementPlayer } from "../audio/elementPlayer.js";
import type { DeckPlayer } from "../audio/types.js";

/**
 * `useDeckPlayer` (src/audio/useDeckPlayer.ts) for the LOK project model.
 *
 * Same external shape and the same rAF-clock discipline — copied
 * deliberately, not reinvented, because `useDeckPlayer`'s own comment records
 * a real bug from getting this wrong (an effect depending on a value rebuilt
 * every render silently killed playback after one frame). Live values are
 * read through refs for exactly that reason: **do not add them to a
 * dependency array.**
 *
 * What's different from `useDeckPlayer`: no `Deck` schema object, no
 * `deckStore`/`LibraryAdapter`, no stems. A LOK project's audio is a plain
 * URL the server serves (`GET /audio`) — `createElementPlayer` is reused
 * as-is since it already only needs a URL. Stems (`StemMixer`/
 * `SeparateStems`/`createStemPlayer`) are deliberately not wired here — they
 * need a server-side upload/storage story of their own; see the Stage 4
 * report for why that's future work, not this hook's job.
 */
export function useLokPlayer(audioUrl: string | null) {
  const playerRef = useRef<DeckPlayer | null>(null);
  const rafRef = useRef<number | null>(null);
  const onTickRef = useRef<((t: number) => void) | null>(null);

  const [player, setPlayer] = useState<DeckPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let built: DeckPlayer | null = null;

    setLoading(true);
    setError(null);

    if (!audioUrl) {
      setLoading(false);
      return;
    }

    built = createElementPlayer(audioUrl);
    playerRef.current = built;
    setPlayer(built);
    void built
      .ready()
      .then(() => {
        if (!cancelled) setDuration(built!.duration());
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      built?.dispose();
      playerRef.current = null;
      setPlayer(null);
      setPlaying(false);
      setTime(0);
      setDuration(0);
    };
  }, [audioUrl]);

  // The tick. Runs only while playing, and reads the player through a ref so
  // nothing about this loop depends on render output — see the module
  // comment for why that matters.
  useEffect(() => {
    if (!playing) return;
    const step = () => {
      const p = playerRef.current;
      if (p) {
        const t = p.currentTime();
        setTime(t);
        onTickRef.current?.(t);
        if (!p.isPlaying()) setPlaying(false);
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  const play = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    try {
      await p.play();
      setDuration(p.duration());
      setPlaying(true);
    } catch (err) {
      // Autoplay policy can refuse a programmatic start; surface it so the
      // caller can prompt for a click rather than looking silently broken.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pause = useCallback(() => {
    playerRef.current?.pause();
    setPlaying(false);
    const t = playerRef.current?.currentTime();
    if (t !== undefined) setTime(t);
  }, []);

  const toggle = useCallback(() => {
    if (playerRef.current?.isPlaying()) pause();
    else void play();
  }, [pause, play]);

  const seek = useCallback((seconds: number) => {
    playerRef.current?.seek(seconds);
    setTime(seconds);
  }, []);

  /** Called every animation frame while playing — used to drive slide cues. */
  const onTick = useCallback((fn: ((t: number) => void) | null) => {
    onTickRef.current = fn;
  }, []);

  return {
    available: player !== null,
    loading,
    error,
    playing,
    time,
    duration,
    play,
    pause,
    toggle,
    seek,
    onTick,
  };
}
