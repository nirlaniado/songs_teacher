import { useRef, useState } from "react";
import { formatCue, parseCue } from "../../schema/deck.js";
import { attachAudio, audioUrl, setSlideTime, type SlideCue } from "../../lok/client.js";
import { useLokPlayer } from "../../lok/useLokPlayer.js";

/**
 * Music sync panel for the LOK-backed editor — Stage 4's core deliverable:
 * attach a track, play it, cue slides to moments in it. Deliberately reuses
 * `formatCue`/`parseCue` from `src/schema/deck.ts` rather than re-deriving
 * them (they're already pure, already unit-tested, and have nothing to do
 * with `Deck` itself — just seconds<->"m:ss" text).
 *
 * What this doesn't do: stems. `StemMixer`/`SeparateStems` are real, shipped
 * features of the existing app, but both read `deckStore` directly (`deck`,
 * `adapter`, `attachStems`, `stemMix`) — wiring them here needs a server-side
 * upload/storage story of their own, not just "point them at a new project".
 * Deferred, not forgotten; see the Stage 4 report for the reasoning.
 */
export interface LokTimingPanelProps {
  hasAudio: boolean;
  slideNames: string[];
  slideSync: SlideCue[];
  activeSlide: number;
  onAudioAttached: () => void;
  onCuesChanged: (slideSync: SlideCue[]) => void;
}

export function LokTimingPanel({
  hasAudio,
  slideNames,
  slideSync,
  activeSlide,
  onAudioAttached,
  onCuesChanged,
}: LokTimingPanelProps) {
  const player = useLokPlayer(hasAudio ? audioUrl() : null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  const [cueError, setCueError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const cueFor = (slide: number) => slideSync.find((c) => c.slide === slide)?.timeMs;

  async function handleFile(file: File) {
    setAttaching(true);
    try {
      await attachAudio(file);
      onAudioAttached();
    } finally {
      setAttaching(false);
    }
  }

  async function applyCue(slide: number, timeMs: number) {
    setCueError(null);
    try {
      const result = await setSlideTime(slide, timeMs);
      onCuesChanged(result.slideSync);
    } catch (e) {
      setCueError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!hasAudio) {
    return (
      <div className="border-t border-neutral-800 bg-neutral-900 p-3">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={attaching}
          className="rounded bg-neutral-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {attaching ? "Attaching…" : "+ Add MP3"}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => player.toggle()}
          disabled={!player.available}
          className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {player.playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(player.duration, 0.01)}
          step={0.1}
          value={player.time}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-24 text-right text-xs tabular-nums text-neutral-400">
          {formatCue(player.time)} / {formatCue(player.duration)}
        </span>
      </div>
      {player.error && <p className="mt-1 text-xs text-red-400">{player.error}</p>}
      {cueError && <p className="mt-1 text-xs text-red-400">{cueError}</p>}

      <div className="mt-3 max-h-40 overflow-y-auto">
        {slideNames.map((name, i) => {
          const timeMs = cueFor(i);
          const draft = drafts[i] ?? (timeMs !== undefined ? formatCue(timeMs / 1000) : "");
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded px-1 py-0.5 text-xs ${
                i === activeSlide ? "bg-neutral-800" : ""
              }`}
            >
              <span className="w-28 truncate text-neutral-300">{name}</span>
              <input
                value={draft}
                placeholder="m:ss"
                onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                onBlur={() => {
                  const parsed = parseCue(draft);
                  if (parsed !== null) void applyCue(i, Math.round(parsed * 1000));
                  setDrafts((d) => {
                    const next = { ...d };
                    delete next[i];
                    return next;
                  });
                }}
                className="w-16 rounded bg-neutral-800 px-1 py-0.5 text-neutral-200"
              />
              <button
                onClick={() => void applyCue(i, Math.round(player.time * 1000))}
                className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-neutral-700"
              >
                Set
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
