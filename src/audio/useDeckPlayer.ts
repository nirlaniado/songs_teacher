import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck } from "../schema/deck.js";
import { useDeckStore } from "../store/deckStore.js";
import { createElementPlayer } from "./elementPlayer.js";
import { createStemPlayer } from "./stemPlayer.js";
import type { DeckPlayer } from "./types.js";

/**
 * Builds the right player for a deck and runs the playback clock.
 *
 * **The clock lives here once.** It used to be duplicated in `TimingPanel` and
 * `PresentMode`, and the copy in `PresentMode` had a bug that killed it after
 * a single frame: the effect depended on a value rebuilt every render, so the
 * first tick re-ran the effect, whose cleanup cancelled the rAF, and nothing
 * restarted it. Live values are read through refs here for exactly that
 * reason — **do not add them to the dependency array.**
 *
 * Which engine runs is decided by the deck: stems mean a Web Audio mixer,
 * otherwise a plain `<audio>` element. Callers never find out which.
 */
export function useDeckPlayer(deck: Deck | null) {
  const adapter = useDeckStore((s) => s.adapter);
  const audioHandle = useDeckStore((s) => s.audio);

  const playerRef = useRef<DeckPlayer | null>(null);
  const rafRef = useRef<number | null>(null);
  const onTickRef = useRef<((t: number) => void) | null>(null);

  const [player, setPlayer] = useState<DeckPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deckId = deck?.id ?? null;
  const stems = deck?.audio?.stems;
  // A stable key: the effect must not re-run because `stems` is a fresh array
  // on every render, only because the actual stem set changed.
  const stemKey = stems ? stems.map((s) => `${s.id}:${s.path}`).sort().join("|") : "";
  const mixUrl = audioHandle?.url ?? null;

  useEffect(() => {
    let cancelled = false;
    let built: DeckPlayer | null = null;

    async function build(): Promise<DeckPlayer | null> {
      if (!deckId) return null;
      if (stemKey !== "" && stems) {
        // Bytes, not an object URL — `decodeAudioData` needs an ArrayBuffer.
        const sources = await Promise.all(
          stems.map(async (stem) => ({
            id: stem.id,
            data: await (await adapter.readDeckAsset(deckId, stem.path)).arrayBuffer(),
          })),
        );
        return createStemPlayer(sources);
      }
      return mixUrl ? createElementPlayer(mixUrl) : null;
    }

    setLoading(true);
    setError(null);
    void build()
      .then(async (next) => {
        if (cancelled) {
          next?.dispose();
          return;
        }
        built = next;
        playerRef.current = next;
        setPlayer(next);
        if (next) {
          await next.ready();
          if (!cancelled) setDuration(next.duration());
        }
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
  }, [deckId, stemKey, mixUrl, adapter, stems]);

  // The tick. Runs only while playing, and reads the player through a ref so
  // nothing about this loop depends on render output.
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

  const setGains = useCallback((gains: Record<string, number>) => {
    playerRef.current?.setGains(gains);
  }, []);

  /** Called every animation frame while playing — used to drive slide cues. */
  const onTick = useCallback((fn: ((t: number) => void) | null) => {
    onTickRef.current = fn;
  }, []);

  return {
    available: player !== null,
    hasStems: stemKey !== "",
    loading,
    error,
    playing,
    time,
    duration,
    play,
    pause,
    toggle,
    seek,
    setGains,
    onTick,
  };
}
