import { useEffect, useRef, useState } from "react";
import { buildCues, formatCue, parseCue, slideIndexAt, type Slide } from "../../schema/deck.js";
import { resolveGains } from "../../audio/mix.js";
import { useDeckPlayer } from "../../audio/useDeckPlayer.js";
import { useDeckStore } from "../../store/deckStore.js";
import { AutoSuggestCues } from "./AutoSuggestCues.js";
import { SeparateStems } from "./SeparateStems.js";
import { StemMixer } from "./StemMixer.js";
import { Button, Field } from "../controls.js";

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
 * Cues earlier than any cue before them (`outOfOrder`), and cues on the same
 * instant as the previous cued slide (`sameTimeAs`, mapping to the first slide
 * of that run). A slide can be both.
 */
/** An example cue in the format `formatCue` writes; `parseCue` also takes plain seconds and decimals. */
export const CUE_PLACEHOLDER = "1:20";

export function cueWarnings(slides: readonly Slide[]): { outOfOrder: Set<number>; sameTimeAs: Map<number, number> } {
  const outOfOrder = new Set<number>();
  const sameTimeAs = new Map<number, number>();
  let maxTime = -Infinity;
  let previous: { index: number; time: number } | null = null;
  for (const [i, slide] of slides.entries()) {
    const time = slide.startTime;
    if (time === undefined) continue;
    if (time < maxTime) outOfOrder.add(i);
    // Only a warning: Deck.superRefine accepts equal times, and tightening it without a versioned migration would stop existing decks with duplicates from loading.
    if (previous && time === previous.time) sameTimeAs.set(i, sameTimeAs.get(previous.index) ?? previous.index);
    maxTime = Math.max(maxTime, time);
    previous = { index: i, time };
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
    <div className="flex h-full flex-col border-t border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Music sync
        </span>

        {deck.audio ? (
          <>
            <Button variant="primary" size="sm" icon="round"
              onClick={player.toggle}
              disabled={!player.available}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "⏸" : "▶"}
            </Button>
            <span className="tabular-nums text-xs text-muted">
              {formatCue(time)} / {duration ? formatCue(duration) : "—"}
            </span>
            <span className="truncate text-[11px] text-faint">
              {deck.audio.originalName ?? deck.audio.path}
            </span>
            <Button variant="destructive-subtle" size="sm" className="ml-auto"
              onClick={() => {
                if (confirm("Remove the audio track? Cue times are kept.")) void removeAudio();
              }}
            >
              Remove audio
            </Button>
          </>
        ) : (
          <>
            <Button size="sm"
              onClick={() => fileInput.current?.click()}
            >
              Add MP3
            </Button>
            <span className="text-[11px] text-faint">
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
          className="relative mx-3 mt-2 h-6 cursor-pointer rounded-control bg-raised"
          onClick={(e) => {
            if (!duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            player.seek(((e.clientX - rect.left) / rect.width) * duration);
          }}
        >
          {duration > 0 &&
            cues.map((cue) => (
              <div
                key={`${cue.index}:${cue.time}`}
                className="cue-mark absolute top-0 h-full w-0.5 bg-accent"
                style={{ left: `${(cue.time / duration) * 100}%` }}
                title={`Slide ${cue.index + 1} @ ${formatCue(cue.time)}`}
              />
            ))}
          {duration > 0 && (
            <div
              className="pointer-events-none absolute top-0 h-full w-0.5 bg-fg"
              style={{ left: `${Math.min(100, (time / duration) * 100)}%` }}
            />
          )}
        </div>
      )}

      <div className="mt-2 flex-1 overflow-y-auto px-3 pb-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-faint">
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
                  className={`border-t border-line ${
                    isLive ? "bg-accent-soft" : i === currentSlide ? "bg-raised" : ""
                  }`}
                >
                  <td className="py-1 text-faint">{i + 1}</td>
                  <td className="py-1">
                    <button
                      onClick={() => selectSlide(i)}
                      className="truncate text-left text-fg hover:text-accent-light"
                    >
                      {slide.name}
                    </button>
                    {outOfOrder.has(i) && (
                      <span className="ml-1 text-[10px] text-warning" title="Cue runs backwards">
                        ⚠ out of order
                      </span>
                    )}
                    {shared !== undefined && (
                      <span
                        className="ml-1 text-[10px] text-warning"
                        title="Two slides on one instant: the music can only show one of them"
                      >
                        ⚠ same time as slide {shared + 1}
                      </span>
                    )}
                  </td>
                  <td className="py-1">
                    <Field
                      size="sm"
                      invalid={bad}
                      value={drafts[slide.id] ?? (slide.startTime !== undefined ? formatCue(slide.startTime) : "")}
                      placeholder={CUE_PLACEHOLDER}
                      aria-label={`Cue time for ${slide.name}`}
                      onChange={(e) => setDrafts((d) => ({ ...d, [slide.id]: e.target.value }))}
                      onBlur={() => commitDraft(i, slide.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className="w-20 tabular-nums"
                    />
                  </td>
                  <td className="py-1">
                    <Button size="sm" className="tabular-nums"
                      onClick={() => setSlideCue(i, Math.round(time * 10) / 10)}
                      disabled={!deck.audio}
                      title="Cue this slide at the current playhead"
                    >
                      Set {deck.audio ? formatCue(time) : ""}
                    </Button>
                    {slide.startTime !== undefined && (
                      <Button variant="destructive-subtle" size="sm" icon className="ml-1"
                        onClick={() => setSlideCue(i, undefined)}
                        title="Clear cue"
                        aria-label={`Clear cue for ${slide.name}`}
                      >
                        ✕
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {deck.slides.length > 0 && cues.length === 0 && (
          <p className="mt-3 text-[11px] text-faint">
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
