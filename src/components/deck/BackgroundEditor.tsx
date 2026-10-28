import { useRef, useState } from "react";
import type { Background, Deck } from "../../schema/deck.js";

/** The image arm of the union — `Background["fit"]` won't resolve on a union. */
type ImageBackground = Extract<Background, { kind: "image" }>;
import { useDeckStore } from "../../store/deckStore.js";
import { useDeckAssets } from "./useDeckAssets.js";

/**
 * Color-or-saved-image backdrop picker, shared by the deck theme (master) and
 * by a single slide's override — the two differ only in where the value is
 * written, so they get one control rather than two that drift apart.
 *
 * "Saved images" are the assets this deck already references anywhere: an
 * image dropped on a slide, or used as any other slide's background. Reusing
 * one costs no extra storage and is how a consistent backdrop gets applied
 * across a deck without re-uploading the same file.
 */

const label = "block text-[11px] text-faint";

/** Every image asset the deck references, for the "reuse a saved image" grid. */
export function savedImagePaths(deck: Deck): string[] {
  const out = new Set<string>();
  if (deck.theme.background.kind === "image") out.add(deck.theme.background.src);
  for (const slide of deck.slides) {
    if (slide.background?.kind === "image") out.add(slide.background.src);
    for (const el of slide.elements) if (el.kind === "image") out.add(el.src);
  }
  return [...out];
}

export function BackgroundEditor({
  value,
  fallbackColor,
  onChange,
  onInherit,
  inheritLabel,
}: {
  /** The backdrop in effect. */
  value: Background;
  /** Color swatch to show when switching to "color" from an image. */
  fallbackColor: string;
  onChange: (background: Background) => void;
  /** Present only for per-slide editing: revert to the deck theme's backdrop. */
  onInherit?: () => void;
  inheritLabel?: string;
}) {
  const deck = useDeckStore((s) => s.deck);
  const uploadImage = useDeckStore((s) => s.uploadImage);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const saved = deck ? savedImagePaths(deck) : [];
  const thumbs = useDeckAssets(saved);

  async function pickFile(file: File) {
    setBusy(true);
    try {
      const src = await uploadImage(file);
      if (src) {
        onChange({
          kind: "image",
          src,
          fit: value.kind === "image" ? value.fit : "cover",
          dim: value.kind === "image" ? value.dim : 0,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const isImage = value.kind === "image";

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <button
          onClick={() => onChange({ kind: "color", color: fallbackColor })}
          className={`flex-1 rounded px-2 py-1 text-[11px] ${
            !isImage ? "bg-accent text-accent-fg" : "bg-raised text-muted"
          }`}
        >
          Color
        </button>
        <button
          onClick={() => {
            // Nothing saved yet — go straight to the file picker rather than
            // switching into an image mode with no image to show.
            if (saved.length === 0) fileInput.current?.click();
            else if (!isImage) onChange({ kind: "image", src: saved[0]!, fit: "cover", dim: 0 });
          }}
          className={`flex-1 rounded px-2 py-1 text-[11px] ${
            isImage ? "bg-accent text-accent-fg" : "bg-raised text-muted"
          }`}
        >
          Image
        </button>
      </div>

      {!isImage && (
        <input
          type="color"
          value={value.color}
          onChange={(e) => onChange({ kind: "color", color: e.target.value })}
          className="h-8 w-full rounded border border-line bg-canvas"
        />
      )}

      {isImage && (
        <>
          {saved.length > 0 && (
            <div>
              <span className={label}>Saved images</span>
              <div className="mt-1 grid grid-cols-3 gap-1">
                {saved.map((src) => (
                  <button
                    key={src}
                    title={src}
                    aria-label={`Saved image ${src.split("/").pop()}`}
                    onClick={() => onChange({ ...value, src })}
                    className={`aspect-video overflow-hidden rounded border-2 bg-canvas ${
                      value.src === src ? "border-accent" : "border-line hover:border-faint"
                    }`}
                  >
                    {thumbs[src] ? (
                      <img src={thumbs[src]} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="block h-full w-full" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className={label}>
            Fit
            <select
              value={value.fit}
              onChange={(e) => onChange({ ...value, fit: e.target.value as ImageBackground["fit"] })}
              className="mt-0.5 w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-fg"
            >
              <option value="cover">Cover — fill, cropping overflow</option>
              <option value="contain">Contain — fit whole image</option>
              <option value="fill">Stretch to fill</option>
              <option value="tile">Tile</option>
            </select>
          </label>

          <label className={label}>
            Dim {Math.round(value.dim * 100)}%
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={value.dim}
              onChange={(e) => onChange({ ...value, dim: Number(e.target.value) })}
              className="mt-0.5 w-full"
            />
            <span className="text-[10px] text-faint">Darkens the image so text stays readable.</span>
          </label>
        </>
      )}

      <div className="flex gap-1">
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="flex-1 rounded bg-raised px-2 py-1 text-[11px] text-muted hover:bg-raised-hover disabled:opacity-40"
        >
          {busy ? "Saving…" : "Upload image…"}
        </button>
        {onInherit && (
          <button
            onClick={onInherit}
            className="flex-1 rounded bg-raised px-2 py-1 text-[11px] text-muted hover:bg-raised-hover"
          >
            {inheritLabel ?? "Use theme"}
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
