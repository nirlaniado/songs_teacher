import type { ChordChartBlock } from "../schema/blocks.js";
import type { KeyRef } from "../schema/song.js";
import { romanNumeralFor } from "../theory/roman.js";

/**
 * Hand-rolled bars-and-beats grid — no chart library does this layout well
 * (see decided stack). One `<div>` per bar; a split bar gets its own nested
 * flex row weighted by `beats`, defaulting to an even split.
 *
 * Numerals are derived per chord symbol (via `romanNumeralFor`), not looked
 * up from `section.progression` by index — a chart's bars don't necessarily
 * mirror the progression array 1:1 (split bars, repeats), so matching by
 * chord symbol is the only mapping that's actually correct here.
 */
export function ChordChart({ block, effectiveKey }: { block: ChordChartBlock; effectiveKey: KeyRef }) {
  const cols = Math.min(block.barsPerLine, 8);
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {block.bars.map((bar, i) => {
        const beats = bar.beats ?? bar.chords.map(() => 1);
        const total = beats.reduce((a, b) => a + b, 0);
        return (
          <div
            key={i}
            className="relative flex h-20 overflow-hidden rounded-surface border border-line bg-panel"
          >
            {bar.chords.map((chord, j) => (
              <div
                key={j}
                style={{ flexGrow: beats[j] ?? 1, flexBasis: 0 }}
                className={`flex flex-col items-center justify-center gap-0.5 ${
                  j > 0 ? "border-l border-line" : ""
                }`}
              >
                <span className="text-lg font-semibold text-fg">{chord}</span>
                {block.showRomanNumerals && (
                  <span className="text-[10px] text-faint">
                    {romanNumeralFor(chord, effectiveKey) ?? ""}
                  </span>
                )}
              </div>
            ))}
            {bar.label && (
              <span className="absolute right-1 top-1 text-[10px] text-faint">
                {bar.label}
              </span>
            )}
            {total === 0 && <div className="flex-1" />}
          </div>
        );
      })}
    </div>
  );
}
