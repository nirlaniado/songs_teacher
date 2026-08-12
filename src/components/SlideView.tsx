import { useLibraryStore } from "../store/libraryStore.js";
import { usePlayerStore } from "../store/playerStore.js";
import { effectiveKey } from "../schema/song.js";
import { romanNumeralsFor } from "../theory/roman.js";
import { ChordChart } from "./ChordChart.js";

/**
 * The slide driven by playback: whichever section the playhead is inside
 * right now. Subscribes only to `activeSectionId`, not `currentTime` — this
 * is what keeps it from re-rendering 60x/sec (see playerStore.ts).
 */
export function SlideView() {
  const song = useLibraryStore((s) => s.currentSong);
  const activeSectionId = usePlayerStore((s) => s.activeSectionId);

  const section = song?.sections.find((s) => s.id === activeSectionId) ?? null;

  if (!song) return null;

  if (!section) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-dashed border-neutral-800 text-sm text-neutral-600">
        {song.sections.length === 0
          ? "Mark a section on the waveform to see its slide here."
          : "Playhead is between sections."}
      </div>
    );
  }

  const key = effectiveKey(song, section);
  const chordChart = section.blocks.find((b) => b.kind === "chordChart");
  const textBlocks = section.blocks.filter((b) => b.kind === "text");
  // Manual override wins (schema comment on `romanNumerals`); otherwise derive
  // from the progression + effective key, same rule the graph index uses.
  const numerals: (string | undefined)[] =
    section.romanNumerals ?? romanNumeralsFor(section.progression, key);
  const numeralsAreDerived = !section.romanNumerals;

  return (
    <div className="flex h-full min-h-64 flex-col rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-2xl font-semibold text-neutral-50">{section.name}</h2>
        <span className="text-sm text-neutral-500">
          {key.tonic} {key.mode}
          {key !== song.key && <span className="ml-1 text-amber-500">· section key</span>}
        </span>
      </div>

      {section.progression.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 text-sm text-neutral-400">
          {section.progression.map((chord, i) => (
            <span key={i} className="rounded bg-neutral-800 px-2 py-0.5">
              {chord}
              {numerals[i] && (
                <span
                  className={`ml-1 ${numeralsAreDerived ? "italic text-neutral-600" : "text-neutral-500"}`}
                  title={numeralsAreDerived ? "derived automatically — override in the section editor if wrong" : "hand-entered"}
                >
                  {numerals[i]}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {chordChart && chordChart.kind === "chordChart" && (
        <div className="mb-4">
          <ChordChart block={chordChart} effectiveKey={key} />
        </div>
      )}

      {textBlocks.map((block) =>
        block.kind === "text" ? (
          <div
            key={block.id}
            className={`whitespace-pre-wrap text-sm ${
              block.emphasis === "callout"
                ? "rounded border border-emerald-900 bg-emerald-950/30 p-3 text-emerald-200"
                : block.emphasis === "aside"
                  ? "italic text-neutral-500"
                  : "text-neutral-300"
            }`}
          >
            {block.markdown}
          </div>
        ) : null,
      )}

      {section.notes && (
        <p className="mt-auto whitespace-pre-wrap pt-4 text-xs text-neutral-600">{section.notes}</p>
      )}
    </div>
  );
}
