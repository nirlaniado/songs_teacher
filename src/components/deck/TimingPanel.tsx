import { useEffect, useRef, useState } from "react";
import { buildCues, formatCue, parseCue, slideIndexAt, type Slide } from "../../schema/deck.js";
import { resolveGains } from "../../audio/mix.js";
import { useDeckPlayer } from "../../audio/useDeckPlayer.js";
import { useDeckStore } from "../../store/deckStore.js";
import { AutoSuggestCues } from "./AutoSuggestCues.js";
import { SeparateStems } from "./SeparateStems.js";
import { StemMixer } from "./StemMixer.js";

/**
 * The music-sync panel: attach an MP3, then give each slide a cue time so the
 * deck plays itself alongside the song.
 *
 * Playback and the clock come from `useDeckPlayer`, which picks a plain
 * `<audio>` element or a Web Audio stem mixer depending on the deck. This
 * panel doesn't know or care which — it just reads `time` and calls `seek`.
 *
 * Cue times must run forward through the deck (enforced in the Deck schema).
 * Rather than let that surface as a validation failure at save time, out-of-
 * order cues are flagged inline the moment they're entered.
 */
/**
 * Cues that break the forward rule (`outOfOrder`), and cues on the same instant
 * as the cued slide before them (`sameTimeAs`, mapping to that slide's index).
 */
export function cueWarnings(slides: readonly Slide[]): { outOfOrder: Set<number>; sameTimeAs: Map<number, number> } {
  const outOfOrder = new Set<number>();
  const sameTimeAs = new Map<number, number>();
  let lastTime = -1;
  let lastIndex = -1;
  for (const [i, slide] of slides.entries()) {
    if (slide.startTime === undefined) continue;
    if (slide.startTime < lastTime) outOfOrder.add(i);
    // Only a warning: Deck.superRefine accepts equal times, and tightening it without a versioned migration would stop existing decks with duplicates from loading.
    else if (slide.startTime === lastTime) sameTimeAs.set(i, lastIndex);
    else {
      lastTime = slide.startTime;
      lastIndex = i;
    }
  }
  return { outOfOrder, sameTimeAs };
}

export function TimingPanel() {
  const deck = useDeckStore((s) => s.deck);
  const attachAudio = useDeckStore((s) => s.attachAudio);
  const removeAudio = useDeckStore((s) => s.removeAudio);
  const setAudioDuration = useDeckStore((s) => s.setAudioDuration);
  const setSlideCue = useDeckStore((s) => s.setSlideCue);
  const selectSlide = useDeckStore((s) => s.selectSlide);
  const currentSlide = useDeckStore((s) => s.currentSlide);
  const stemMix = useDeckStore((s) => s.stemMix);

  const player = useDeckPlayer(deck);
  const fileInput = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const time = player.time;
  const playing = player.playing;
  const duration = player.duration || deck?.audio?.duration || 0;

  // Record the real duration once the player knows it, so the timeline strip
  // has a scale before the track is ever played.
  useEffect(() => {
    if (player.duration > 0) setAudioDuration(player.duration);
  }, [player.duration, setAudioDuration]);

  // Push mixer changes down to the audio graph. A no-op for a deck with no
  // stems, whose player ignores gains entirely.
  useEffect(() => {
    player.setGains(resolveGains(stemMix));
  }, [stemMix, player]);

  if (!deck) return null;

  const cues = buildCues(deck.slides);
  const liveIndex = slideIndexAt(cues, time);

  const { outOfOrder, sameTimeAs } = cueWarnings(deck.slides);

  function commitDraft(index: number, slideId: string) {
    const raw = drafts[slideId];
    if (raw === undefined) return;
    setDrafts((d) => {
      const { [slideId]: _drop, ...rest } = d;
      return rest;
    });
    if (raw.trim() === "") {
      setSlideCue(index, undefined);
      return;
    }
    const seconds = parseCue(raw);
    if (seconds !== null) setSlideCue(index, seconds);
  }

  return (
    <div className="flex h-full flex-col border-t border-neutral-800 bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Music sync
        </span>

        {deck.audio ? (
          <>
            <button
              onClick={player.toggle}
              disabled={!player.available}
              className="rounded bg-emerald-700 px-2 py-0.5 text-xs text-white disabled:opacity-40"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <span className="tabular-nums text-xs text-neutral-400">
              {formatCue(time)} / {duration ? formatCue(duration) : "—"}
            </span>
            <span className="truncate text-[11px] text-neutral-600">
              {deck.audio.originalName ?? deck.audio.path}
            </span>
            <button
              onClick={() => {
                if (confirm("Remove the audio track? Cue times are kept.")) void removeAudio();
              }}
              className="ml-auto text-[11px] text-neutral-500 hover:text-red-400"
            >
              Remove audio
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
            >
              Add MP3
            </button>
            <span className="text-[11px] text-neutral-600">
              Attach a track, then cue each slide to a moment in the song.
            </span>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="audio/mpeg,audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void attachAudio(f);
            e.target.value = "";
          }}
        />
      </div>

      {/* Timeline strip: cue marks over the song, click to scrub. */}
      {deck.audio && (
        <div
          className="relative mx-3 mt-2 h-6 cursor-pointer rounded bg-neutral-800"
          onClick={(e) => {
            if (!duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            player.seek(((e.clientX - rect.left) / rect.width) * duration);
          }}
        >
          {duration > 0 &&
            cues.map((cue) => (
              <div
                key={cue.index}
                className="absolute top-0 h-full w-0.5 bg-emerald-400"
                style={{ left: `${(cue.time / duration) * 100}%` }}
                title={`Slide ${cue.index + 1} @ ${formatCue(cue.time)}`}
              />
            ))}
          {duration > 0 && (
            <div
              className="pointer-events-none absolute top-0 h-full w-0.5 bg-amber-400"
              style={{ left: `${Math.min(100, (time / duration) * 100)}%` }}
            />
          )}
        </div>
      )}

      <div className="mt-2 flex-1 overflow-y-auto px-3 pb-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-600">
              <th className="w-8 pb-1">#</th>
              <th className="pb-1">Slide</th>
              <th className="w-24 pb-1">Cue</th>
              <th className="w-28 pb-1" />
            </tr>
          </thead>
          <tbody>
            {deck.slides.map((slide, i) => {
              const isLive = liveIndex === i;
              const shared = sameTimeAs.get(i);
              const bad = outOfOrder.has(i) || shared !== undefined;
              return (
                <tr
                  key={slide.id}
                  className={`border-t border-neutral-800/70 ${
                    isLive ? "bg-emerald-950/40" : i === currentSlide ? "bg-neutral-800/40" : ""
                  }`}
                >
                  <td className="py-1 text-neutral-500">{i + 1}</td>
                  <td className="py-1">
                    <button
                      onClick={() => selectSlide(i)}
                      className="truncate text-left text-neutral-200 hover:text-sky-400"
                    >
                      {slide.name}
                    </button>
                    {outOfOrder.has(i) && (
                      <span className="ml-1 text-[10px] text-amber-500" title="Cue runs backwards">
                        ⚠ out of order
                      </span>
                    )}
                    {shared !== undefined && (
                      <span
                        className="ml-1 text-[10px] text-amber-500"
                        title="Two slides on one instant: the music can only show one of them"
                      >
                        ⚠ same time as slide {shared + 1}
                      </span>
                    )}
                  </td>
                  <td className="py-1">
                    <input
                      value={drafts[slide.id] ?? (slide.startTime !== undefined ? formatCue(slide.startTime) : "")}
                      placeholder="—"
                      onChange={(e) => setDrafts((d) => ({ ...d, [slide.id]: e.target.value }))}
                      onBlur={() => commitDraft(i, slide.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className={`w-20 rounded border bg-neutral-950 px-1.5 py-0.5 tabular-nums ${
                        bad ? "border-amber-600 text-amber-300" : "border-neutral-700 text-neutral-200"
                      }`}
                    />
                  </td>
                  <td className="py-1">
                    <button
                      onClick={() => setSlideCue(i, Math.round(time * 10) / 10)}
                      disabled={!deck.audio}
                      title="Cue this slide at the current playhead"
                      className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-30"
                    >
                      Set {deck.audio ? formatCue(time) : ""}
                    </button>
                    {slide.startTime !== undefined && (
                      <button
                        onClick={() => setSlideCue(i, undefined)}
                        title="Clear cue"
                        className="ml-1 text-[10px] text-neutral-600 hover:text-red-400"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {deck.slides.length > 0 && cues.length === 0 && (
          <p className="mt-3 text-[11px] text-neutral-600">
            No cues yet. Play the track, and press <em>Set</em> on a slide when the song reaches
            the moment that slide should appear.
          </p>
        )}
      </div>

      {/* Each renders only when relevant: the offer to separate when there
          are no stems yet, the mixer once there are. */}
      <AutoSuggestCues />
      <SeparateStems />
      <StemMixer />
    </div>
  );
}
