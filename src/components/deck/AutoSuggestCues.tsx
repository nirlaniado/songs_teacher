import { useRef, useState } from "react";
import { cuesForAudio, sectionsOfSlides, type AutoCueResult } from "../../audio/autoCue.js";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * Suggests a cue for every slide by finding where the song changes, then
 * assigning slides to those points in order.
 *
 * Suggestions only: it is right when the number of parts in the recording
 * matches the number of slides, and off when the chart's structure differs
 * from the recording. The result lands in the ordinary timing rows, so any
 * wrong cue is fixed with the same Set button as always, and one Ctrl+Z
 * undoes the whole batch.
 */
/** One line saying how many slides were cued and whether the lyrics or only the music timed them. */
export function suggestionMessage(result: Pick<AutoCueResult, "source" | "note">, placed: number, slides: number): string {
  const count = placed < slides
    ? `Found ${placed} distinct parts for ${slides} slides — the rest are left uncued.`
    : "Cued every slide.";
  const source = result.source === "lyrics"
    ? "Timed from the lyrics."
    : `Timed from the music alone${result.note ? ` — ${result.note}` : ""}.`;
  return `${count} ${source} Check them by ear.`;
}

export function AutoSuggestCues() {
  const deck = useDeckStore((s) => s.deck);
  const adapter = useDeckStore((s) => s.adapter);
  const setSlideCues = useDeckStore((s) => s.setSlideCues);

  const [running, setRunning] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [detail, setDetail] = useState<string | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!deck?.audio) return null;

  async function run() {
    if (!deck?.audio) return;
    const hasCues = deck.slides.some((s) => s.startTime !== undefined);
    if (hasCues && !window.confirm("Replace the cues already set on this deck? You can undo it afterwards.")) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setMessage(null);
    setFraction(0);
    setDetail(undefined);
    try {
      const mix = await adapter.readDeckAsset(deck.id, deck.audio.path);

      // The vocals stem, when the deck has one, pins down where the intro ends.
      const vocalsRef = deck.audio.stems?.find((s) => s.id === "vocals");
      const vocals = vocalsRef ? await adapter.readDeckAsset(deck.id, vocalsRef.path) : undefined;

      // A deck doesn't keep the chart's lyrics, so re-running here times from the music alone.
      const { times, source, note } = await cuesForAudio(mix, sectionsOfSlides(deck.slides), {
        vocals,
        signal: controller.signal,
        onProgress: (f, d) => {
          setFraction(f);
          setDetail(d);
        },
      });
      const applied = setSlideCues(deck.slides.map((_, index) => ({ index, seconds: times[index] })));
      const placed = times.filter((t) => t !== undefined).length;
      if (!applied) setError("The suggested cues didn't run forward, so nothing was changed.");
      else setMessage(suggestionMessage({ source, note }, placed, deck.slides.length));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="border-t border-neutral-800 px-3 py-2">
      {!running ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void run()}
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Auto-suggest cues
          </button>
          <span className="text-[11px] text-neutral-600">
            Cues each slide from where the music changes (nothing is uploaded). Decks made
            from the chord agent are timed by their lyrics when they are created.
          </span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px] text-neutral-300">
            <span>{detail ?? "Analysing"}…</span>
            <button
              onClick={() => abortRef.current?.abort()}
              className="ml-auto text-neutral-500 hover:text-red-400"
            >
              Cancel
            </button>
          </div>
          <div className="h-1 overflow-hidden rounded bg-neutral-800">
            <div className="h-full bg-sky-600 transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        </div>
      )}

      {message && <p className="mt-1 text-[11px] text-emerald-400">{message}</p>}
      {error && (
        <p className="mt-1 rounded border border-red-900 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">{error}</p>
      )}
    </div>
  );
}
