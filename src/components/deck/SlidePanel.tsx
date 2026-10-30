import { useState } from "react";
import { formatCue } from "../../schema/deck.js";
import { useDeckStore } from "../../store/deckStore.js";
import { SlideRenderer, imagePathsOf } from "./SlideRenderer.js";
import { useDeckAssets } from "./useDeckAssets.js";
import { Button } from "../controls.js";

const THUMB_SCALE = 0.115; // 1280x720 -> ~147x83

/** Left rail: ordered thumbnails, drag to reorder, cue time badge. */
export function SlidePanel() {
  const deck = useDeckStore((s) => s.deck);
  const current = useDeckStore((s) => s.currentSlide);
  const selectSlide = useDeckStore((s) => s.selectSlide);
  const addSlide = useDeckStore((s) => s.addSlide);
  const duplicateSlide = useDeckStore((s) => s.duplicateSlide);
  const deleteSlide = useDeckStore((s) => s.deleteSlide);
  const moveSlide = useDeckStore((s) => s.moveSlide);

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const assetUrls = useDeckAssets(imagePathsOf(deck?.slides ?? [], deck?.theme));

  if (!deck) return null;

  return (
    <div className="flex h-full w-44 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5">
        <span className="text-xs font-medium text-muted">Slides</span>
        <Button size="sm" icon
          onClick={() => addSlide()}
          title="New slide"
          aria-label="New slide"
        >
          +
        </Button>
      </div>

      <ul className="flex-1 space-y-2 overflow-y-auto p-2">
        {deck.slides.map((slide, i) => (
          <li
            key={slide.id}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom !== null && dragFrom !== i) moveSlide(dragFrom, i);
              setDragFrom(null);
            }}
            onDragEnd={() => setDragFrom(null)}
            className="group relative"
          >
            <button
              onClick={() => selectSlide(i)}
              aria-current={i === current ? "true" : undefined}
              aria-label={`Slide ${i + 1}: ${slide.name}`} className="slide-thumb block w-full rounded-slide border-2 border-transparent hover:border-line"
            >
              <div className="flex items-start gap-1">
                <span className="w-4 pt-1 text-right text-[10px] text-faint">{i + 1}</span>
                <SlideRenderer
                  slide={slide}
                  theme={deck.theme}
                  scale={THUMB_SCALE}
                  assetUrls={assetUrls}
                  className="ring-1 ring-line"
                />
              </div>
            </button>

            {slide.startTime !== undefined && (
              <span className="pointer-events-none absolute bottom-0.5 right-0.5 rounded-control bg-accent px-1 text-[9px] tabular-nums text-accent-fg">
                {formatCue(slide.startTime)}
              </span>
            )}

            <div className="fade absolute right-0.5 top-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
              <Button size="sm" icon
                onClick={() => duplicateSlide(i)}
                title="Duplicate"
                aria-label={`Duplicate slide ${i + 1}`}
              >
                ⧉
              </Button>
              <Button size="sm" icon className="hover:text-danger"
                onClick={() => {
                  if (confirm(`Delete slide ${i + 1}?`)) deleteSlide(i);
                }}
                title="Delete"
                aria-label={`Delete slide ${i + 1}`}
              >
                ✕
              </Button>
            </div>
          </li>
        ))}
        {deck.slides.length === 0 && (
          <li className="px-1 py-4 text-center text-[11px] text-faint">
            No slides. Press + to add one.
          </li>
        )}
      </ul>
    </div>
  );
}
