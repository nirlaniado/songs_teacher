import { useRef, useState } from "react";
import type { Background, Deck } from "../../schema/deck.js";

/** The image arm of the union — `Background["fit"]` won't resolve on a union. */
type ImageBackground = Extract<Background, { kind: "image" }>;
import { useDeckStore } from "../../store/deckStore.js";
import { useDeckAssets } from "./useDeckAssets.js";
import { Button, Field } from "../controls.js";

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
        <Button size="sm" className="flex-1" pressed={!isImage}
          onClick={() => onChange({ kind: "color", color: fallbackColor })}
        >
          Color
        </Button>
        <Button size="sm" className="flex-1" pressed={isImage}
          onClick={() => {
            // Nothing saved yet — go straight to the file picker rather than
            // switching into an image mode with no image to show.
            if (saved.length === 0) fileInput.current?.click();
            else if (!isImage) onChange({ kind: "image", src: saved[0]!, fit: "cover", dim: 0 });
          }}
        >
          Image
        </Button>
      </div>

      {!isImage && (
        <Field
          type="color"
          value={value.color}
          onChange={(e) => onChange({ kind: "color", color: e.target.value })}
          className="w-full"
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
                    aria-pressed={value.src === src}
                    aria-label={`Saved image ${src.split("/").pop()}`}
                    onClick={() => onChange({ ...value, src })} className="tile aspect-video overflow-hidden"
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
            <Field
              as="select"
              size="sm"
              value={value.fit}
              onChange={(e) => onChange({ ...value, fit: e.target.value as ImageBackground["fit"] })}
              className="mt-0.5 w-full"
            >
              <option value="cover">Cover — fill, cropping overflow</option>
              <option value="contain">Contain — fit whole image</option>
              <option value="fill">Stretch to fill</option>
              <option value="tile">Tile</option>
            </Field>
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
        <Button size="sm" className="flex-1"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Upload image…"}
        </Button>
        {onInherit && (
          <Button size="sm" className="flex-1"
            onClick={onInherit}
          >
            {inheritLabel ?? "Use theme"}
          </Button>
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
