import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SLIDE_H, SLIDE_W, buildCues, formatCue, slideIndexAt } from "../../schema/deck.js";
import { resolveGains } from "../../audio/mix.js";
import { useDeckPlayer } from "../../audio/useDeckPlayer.js";
import { useDeckStore } from "../../store/deckStore.js";
import { SlideRenderer, imagePathsOf } from "./SlideRenderer.js";
import { useDeckAssets } from "./useDeckAssets.js";

/**
 * Fullscreen playback: the song plays and the deck follows its cues.
 *
 * Auto-advance is *advisory*, not a lock. If the presenter presses an arrow
 * key, `manualIndex` takes over and the clock stops driving the slide until
 * they either resume auto-follow or the next cue is reached — a teacher who
 * flips back a slide to answer a question should not have it yanked forward
 * again a second later.
 *
 * Uncued slides are skipped by the clock but remain reachable with the arrow
 * keys, so a deck can mix timed and untimed material.
 */
export function PresentMode({ onExit }: { onExit: () => void }) {
  const deck = useDeckStore((s) => s.deck);
  const startIndex = useDeckStore((s) => s.currentSlide);

  const rootRef = useRef<HTMLDivElement>(null);
  const stemMix = useDeckStore((s) => s.stemMix);
  const player = useDeckPlayer(deck);

  const [scale, setScale] = useState(1);
  const [index, setIndex] = useState(startIndex);
  const [manual, setManual] = useState(false);
  const [chrome, setChrome] = useState(true);
  /** Set when the browser refused autoplay, so we can ask for one click. */
  const [needsGesture, setNeedsGesture] = useState(false);

  const slides = deck?.slides ?? [];
  const assetUrls = useDeckAssets(imagePathsOf(slides, deck?.theme));
  // Memoized: `buildCues` returns a new array, and the cue effect below must
  // not re-run just because the component re-rendered.
  const cues = useMemo(() => (deck ? buildCues(deck.slides) : []), [deck]);
  const time = player.time;
  const playing = player.playing;
  const duration = player.duration || deck?.audio?.duration || 0;

  // Read inside the tick callback rather than closed over, so the callback
  // never has to be torn down and rebuilt when they change.
  const cuesRef = useRef(cues);
  const manualRef = useRef(manual);
  cuesRef.current = cues;
  manualRef.current = manual;

  // Scale the fixed 1280x720 slide to fill the viewport, preserving aspect.
  useLayoutEffect(() => {
    const measure = () => {
      const el = rootRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      setScale(Math.min(width / SLIDE_W, height / SLIDE_H));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Try real fullscreen; if the browser refuses, the fixed-inset overlay still
  // covers the window, so presenting works either way.
  useEffect(() => {
    void rootRef.current?.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const goTo = useCallback(
    (next: number) => {
      setIndex(Math.max(0, Math.min(next, slides.length - 1)));
      setManual(true);
    },
    [slides.length],
  );

  /**
   * Cue-following. The clock itself lives in `useDeckPlayer`; this only says
   * what to do on each tick.
   *
   * Live values are read through refs so this callback is registered once and
   * never rebuilt mid-playback — an earlier version of the clock listed the
   * rebuilt-every-render `cues` array as a dependency, which tore down the
   * loop on the first tick and left slides stuck. Do not close over `cues` or
   * `manual` here.
   */
  useEffect(() => {
    player.onTick((t) => {
      if (manualRef.current) return;
      const cued = slideIndexAt(cuesRef.current, t);
      if (cued !== null) setIndex(cued);
    });
    return () => player.onTick(null);
  }, [player]);

  /**
   * Start the show once, when the player is ready.
   *
   * Presenting from a cued slide resumes at that moment rather than rewinding
   * — otherwise entering Present on slide 5 would jump straight back to slide
   * 1 as soon as the clock ticked.
   */
  const startedRef = useRef(false);
  useEffect(() => {
    if (!player.available || startedRef.current) return;
    startedRef.current = true;
    const startCue = deck?.slides[startIndex]?.startTime;
    if (startCue !== undefined && startCue > 0) player.seek(startCue);
    void player.play();
  }, [player, deck, startIndex]);

  // Browsers can refuse programmatic playback when they don't credit the click
  // that opened this view as a user gesture. Surface a prompt rather than
  // appearing silently broken.
  useEffect(() => {
    if (player.error) setNeedsGesture(true);
  }, [player.error]);

  // Push the editor's mixer settings into the presentation, so a deck
  // presented with vocals muted stays that way.
  useEffect(() => {
    player.setGains(resolveGains(stemMix));
  }, [stemMix, player]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      switch (e.key) {
        case "Escape":
          onExit();
          break;
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          goTo(index + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          goTo(index - 1);
          break;
        case "Home":
          goTo(0);
          break;
        case "End":
          goTo(slides.length - 1);
          break;
        case "f":
          setManual(false); // resume following the music
          break;
        case "p":
          player.toggle();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goTo, onExit, slides.length]);

  // Hide the chrome while the mouse is still, like a video player.
  useEffect(() => {
    let timer: number;
    const wake = () => {
      setChrome(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setChrome(false), 2500);
    };
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
    };
  }, []);

  if (!deck) return null;
  const slide = slides[index] ?? null;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      tabIndex={-1}
    >
      <SlideRenderer slide={slide} theme={deck.theme} scale={scale} assetUrls={assetUrls} />

      {needsGesture && (
        <button
          onClick={() => {
            void player.play();
            setNeedsGesture(false);
          }}
          className="absolute inset-0 flex items-center justify-center bg-black/70 text-neutral-100"
        >
          <span className="rounded-lg border border-neutral-600 bg-neutral-900 px-6 py-4 text-center">
            <span className="block text-lg">▶ Click to start</span>
            <span className="mt-1 block text-xs text-neutral-400">
              Your browser blocked playback from starting on its own.
            </span>
          </span>
        </button>
      )}

      {chrome && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/85 to-transparent px-5 pb-4 pt-10 text-sm text-neutral-200">
          <button onClick={() => goTo(index - 1)} disabled={index === 0} aria-label="Previous slide" className="disabled:opacity-30">
            ←
          </button>
          <span className="tabular-nums">
            {slides.length === 0 ? 0 : index + 1} / {slides.length}
          </span>
          <button
            onClick={() => goTo(index + 1)}
            disabled={index >= slides.length - 1}
            aria-label="Next slide"
            className="disabled:opacity-30"
          >
            →
          </button>

          {deck.audio && (
            <>
              <span className="mx-1 h-4 w-px bg-white/20" />
              <button
                onClick={player.toggle}
                aria-label={playing ? "Pause" : "Play"}
                className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white"
              >
                {playing ? "⏸" : "▶"}
              </button>
              <span className="tabular-nums text-xs text-neutral-400">
                {formatCue(time)}
                {duration ? ` / ${formatCue(duration)}` : ""}
              </span>

              <div
                className="relative h-1.5 flex-1 cursor-pointer rounded bg-white/20"
                onClick={(e) => {
                  if (!duration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  player.seek(((e.clientX - rect.left) / rect.width) * duration);
                  // Scrubbing is an explicit "follow the music from here",
                  // so it also clears any manual slide override.
                  setManual(false);
                }}
              >
                {duration > 0 &&
                  cues.map((c) => (
                    <div
                      key={c.index}
                      className="absolute top-0 h-full w-0.5 bg-emerald-400"
                      style={{ left: `${(c.time / duration) * 100}%` }}
                    />
                  ))}
                {duration > 0 && (
                  <div
                    className="absolute top-0 h-full bg-amber-400/80"
                    style={{ width: `${Math.min(100, (time / duration) * 100)}%` }}
                  />
                )}
              </div>

              <button
                onClick={() => setManual(false)}
                title="Resume following the music"
                className={`rounded px-2 py-0.5 text-xs ${
                  manual ? "bg-amber-600 text-white" : "bg-white/10 text-neutral-400"
                }`}
              >
                {manual ? "Manual — click to follow" : "Following music"}
              </button>
            </>
          )}

          <button onClick={onExit} className="ml-auto text-xs text-neutral-400 hover:text-white">
            Exit (Esc)
          </button>
        </div>
      )}
    </div>
  );
}
