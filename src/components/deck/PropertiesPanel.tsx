import { LAYOUTS, THEME_PRESETS, padTabLines } from "../../deck/templates.js";
import { boundsOf } from "../../deck/geometry.js";
import { SLIDE_H, SLIDE_W, type SlideElement } from "../../schema/deck.js";
import { useDeckStore } from "../../store/deckStore.js";
import { BackgroundEditor } from "./BackgroundEditor.js";

/**
 * The right rail — the Properties sidebar from Impress: slide format,
 * background, master/theme, layouts; plus the selected element's own
 * properties, which Impress splits across several dialogs.
 */

const field = "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200";
const label = "block text-[11px] text-neutral-500";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-800 px-3 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function NumberField({
  label: text,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className={label}>
      {text}
      <input
        type="number"
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className={`${field} mt-0.5`}
      />
    </label>
  );
}

/**
 * What Impress shows for a multi-selection: position and size read as the
 * group's bounding box and are not editable, and the commands on offer are the
 * ones that mean something for several objects at once.
 */
function MultiSelectionProps({ elements }: { elements: SlideElement[] }) {
  const arrangeSelection = useDeckStore((s) => s.arrangeSelection);
  const alignSelection = useDeckStore((s) => s.alignSelection);
  const distributeSelection = useDeckStore((s) => s.distributeSelection);
  const duplicateSelection = useDeckStore((s) => s.duplicateSelection);
  const deleteSelection = useDeckStore((s) => s.deleteSelection);
  const updateSelection = useDeckStore((s) => s.updateSelection);

  const bounds = boundsOf(elements);
  const allLocked = elements.every((el) => el.locked);
  const small = "rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-35";

  return (
    <>
      <Section title={`${elements.length} elements selected`}>
        {bounds && (
          <div className="text-[11px] text-neutral-500">
            {Math.round(bounds.x)}, {Math.round(bounds.y)} · {Math.round(bounds.w)}×
            {Math.round(bounds.h)}
          </div>
        )}
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              ["left", "Align left"],
              ["center", "Centre H"],
              ["right", "Align right"],
              ["top", "Align top"],
              ["middle", "Centre V"],
              ["bottom", "Align bottom"],
            ] as const
          ).map(([mode, title]) => (
            <button key={mode} title={title} onClick={() => alignSelection(mode)} className={small}>
              {title.replace("Align ", "").replace("Centre ", "C·")}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button
            disabled={elements.length < 3}
            onClick={() => distributeSelection("horizontal")}
            className={`${small} flex-1`}
            title="Needs three or more"
          >
            Distribute H
          </button>
          <button
            disabled={elements.length < 3}
            onClick={() => distributeSelection("vertical")}
            className={`${small} flex-1`}
            title="Needs three or more"
          >
            Distribute V
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button onClick={() => arrangeSelection("front")} className={small}>
            Bring to front
          </button>
          <button onClick={() => arrangeSelection("back")} className={small}>
            Send to back
          </button>
          <button onClick={() => arrangeSelection("forward")} className={small}>
            Forward
          </button>
          <button onClick={() => arrangeSelection("backward")} className={small}>
            Backward
          </button>
        </div>
        <button onClick={duplicateSelection} className={`${small} w-full`}>
          Duplicate (Ctrl+D)
        </button>
        <label className="flex items-center gap-2 pt-1 text-[11px] text-neutral-400">
          <input
            type="checkbox"
            checked={allLocked}
            onChange={(e) => updateSelection((el) => ({ ...el, locked: e.target.checked }))}
          />
          Lock position
        </label>
        <button
          onClick={deleteSelection}
          className="w-full rounded bg-red-900/60 px-2 py-1 text-[11px] text-red-200 hover:bg-red-800"
        >
          Delete {elements.length} elements
        </button>
      </Section>
    </>
  );
}

function ElementProps({ element }: { element: SlideElement }) {
  const updateElement = useDeckStore((s) => s.updateElement);
  const deleteElement = useDeckStore((s) => s.deleteElement);
  const reorderElement = useDeckStore((s) => s.reorderElement);
  const alignSelection = useDeckStore((s) => s.alignSelection);
  const patch = (fn: (el: SlideElement) => SlideElement) => updateElement(element.id, fn);

  return (
    <>
      <Section title={`${element.kind} · position`}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={element.x} onChange={(x) => patch((el) => ({ ...el, x }))} />
          <NumberField label="Y" value={element.y} onChange={(y) => patch((el) => ({ ...el, y }))} />
          <NumberField
            label="Width"
            value={element.w}
            onChange={(w) => patch((el) => ({ ...el, w: Math.max(8, w) }))}
          />
          <NumberField
            label="Height"
            value={element.h}
            onChange={(h) => patch((el) => ({ ...el, h: Math.max(8, h) }))}
          />
          <NumberField
            label="Rotation°"
            value={element.rotation}
            onChange={(rotation) => patch((el) => ({ ...el, rotation }))}
          />
        </div>
        <label className="flex items-center gap-2 pt-1 text-[11px] text-neutral-400">
          <input
            type="checkbox"
            checked={element.locked}
            onChange={(e) => patch((el) => ({ ...el, locked: e.target.checked }))}
          />
          Lock position
        </label>
        {/* On a single element, align centres it on the slide — Impress's
            rule, and the fastest way to place one thing precisely. */}
        <div className="grid grid-cols-3 gap-1 pt-1">
          {(
            [
              ["left", "Left"],
              ["center", "C·H"],
              ["right", "Right"],
              ["top", "Top"],
              ["middle", "C·V"],
              ["bottom", "Bottom"],
            ] as const
          ).map(([mode, text]) => (
            <button
              key={mode}
              title={`Align ${mode} on the slide`}
              onClick={() => alignSelection(mode, "slide")}
              className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              {text}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1 pt-1">
          {(
            [
              ["front", "Bring to front"],
              ["back", "Send to back"],
              ["forward", "Forward"],
              ["backward", "Backward"],
            ] as const
          ).map(([direction, text]) => (
            <button
              key={direction}
              onClick={() => reorderElement(element.id, direction)}
              className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              {text}
            </button>
          ))}
        </div>
        <button
          onClick={() => deleteElement(element.id)}
          className="w-full rounded bg-red-900/60 px-2 py-1 text-[11px] text-red-200 hover:bg-red-800"
        >
          Delete element
        </button>
      </Section>

      {element.kind === "text" && (
        <Section title="Text">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Size"
              value={element.style.fontSize}
              onChange={(fontSize) =>
                patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, fontSize } } : el))
              }
            />
            <NumberField
              label="Line height"
              step={0.05}
              value={element.style.lineHeight}
              onChange={(lineHeight) =>
                patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, lineHeight } } : el))
              }
            />
          </div>
          <div className="flex gap-1">
            {(["bold", "italic", "underline"] as const).map((k) => (
              <button
                key={k}
                onClick={() =>
                  patch((el) =>
                    el.kind === "text" ? { ...el, style: { ...el.style, [k]: !el.style[k] } } : el,
                  )
                }
                className={`flex-1 rounded px-2 py-1 text-[11px] ${
                  element.style[k] ? "bg-sky-700 text-white" : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {k === "bold" ? "B" : k === "italic" ? "I" : "U"}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                onClick={() =>
                  patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, align: a } } : el))
                }
                className={`flex-1 rounded px-2 py-1 text-[11px] ${
                  element.style.align === a ? "bg-sky-700 text-white" : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["top", "middle", "bottom"] as const).map((v) => (
              <button
                key={v}
                onClick={() =>
                  patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, valign: v } } : el))
                }
                className={`flex-1 rounded px-2 py-1 text-[11px] ${
                  element.style.valign === v ? "bg-sky-700 text-white" : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <label className={label}>
            Color (blank = theme)
            <div className="mt-0.5 flex gap-1">
              <input
                type="color"
                value={element.style.color ?? "#111827"}
                onChange={(e) =>
                  patch((el) =>
                    el.kind === "text" ? { ...el, style: { ...el.style, color: e.target.value } } : el,
                  )
                }
                className="h-7 w-10 rounded border border-neutral-700 bg-neutral-950"
              />
              <button
                onClick={() =>
                  patch((el) => {
                    if (el.kind !== "text") return el;
                    const { color: _drop, ...style } = el.style;
                    return { ...el, style };
                  })
                }
                className="flex-1 rounded bg-neutral-800 px-2 text-[11px] text-neutral-300 hover:bg-neutral-700"
              >
                Use theme
              </button>
            </div>
          </label>
        </Section>
      )}

      {element.kind === "tab" && (
        <Section title="Tab">
          <button
            title="Pad every line to the same length with trailing dashes, so the diagram forms a clean rectangle instead of a ragged edge"
            onClick={() =>
              patch((el) => (el.kind === "tab" ? { ...el, text: padTabLines(el.text) } : el))
            }
            className="w-full rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
          >
            Complete — even out line lengths
          </button>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Size"
              value={element.style.fontSize}
              onChange={(fontSize) =>
                patch((el) => (el.kind === "tab" ? { ...el, style: { ...el.style, fontSize } } : el))
              }
            />
            <NumberField
              label="Line height"
              step={0.05}
              value={element.style.lineHeight}
              onChange={(lineHeight) =>
                patch((el) =>
                  el.kind === "tab" ? { ...el, style: { ...el.style, lineHeight } } : el,
                )
              }
            />
          </div>
          {/* No bold/italic/align here — see TabStyle in the schema: they all
              break the monospace grid a tab diagram depends on. */}
          <div className="flex gap-1">
            {(["top", "middle", "bottom"] as const).map((v) => (
              <button
                key={v}
                onClick={() =>
                  patch((el) => (el.kind === "tab" ? { ...el, style: { ...el.style, valign: v } } : el))
                }
                className={`flex-1 rounded px-2 py-1 text-[11px] ${
                  element.style.valign === v ? "bg-sky-700 text-white" : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <label className={label}>
            Color (blank = theme)
            <div className="mt-0.5 flex gap-1">
              <input
                type="color"
                value={element.style.color ?? "#111827"}
                onChange={(e) =>
                  patch((el) =>
                    el.kind === "tab" ? { ...el, style: { ...el.style, color: e.target.value } } : el,
                  )
                }
                className="h-7 w-10 rounded border border-neutral-700 bg-neutral-950"
              />
              <button
                onClick={() =>
                  patch((el) => {
                    if (el.kind !== "tab") return el;
                    const { color: _drop, ...style } = el.style;
                    return { ...el, style };
                  })
                }
                className="flex-1 rounded bg-neutral-800 px-2 text-[11px] text-neutral-300 hover:bg-neutral-700"
              >
                Use theme
              </button>
            </div>
          </label>
        </Section>
      )}

      {element.kind === "image" && (
        <Section title="Image">
          <label className={label}>
            Fit
            <select
              value={element.fit}
              onChange={(e) =>
                patch((el) =>
                  el.kind === "image" ? { ...el, fit: e.target.value as typeof el.fit } : el,
                )
              }
              className={`${field} mt-0.5`}
            >
              <option value="contain">contain</option>
              <option value="cover">cover</option>
              <option value="fill">fill</option>
            </select>
          </label>
          <p className="truncate text-[10px] text-neutral-600" title={element.src}>
            {element.src}
          </p>
        </Section>
      )}

      {element.kind === "shape" && (
        <Section title="Shape">
          <label className={label}>
            Shape
            <select
              value={element.shape}
              onChange={(e) =>
                patch((el) =>
                  el.kind === "shape" ? { ...el, shape: e.target.value as typeof el.shape } : el,
                )
              }
              className={`${field} mt-0.5`}
            >
              <option value="rect">Rectangle</option>
              <option value="roundRect">Rounded rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="line">Line</option>
              <option value="arrow">Arrow</option>
            </select>
          </label>
          <label className={label}>
            Fill
            <input
              type="color"
              value={element.fill ?? "#2563eb"}
              onChange={(e) =>
                patch((el) => (el.kind === "shape" ? { ...el, fill: e.target.value } : el))
              }
              className="mt-0.5 h-7 w-full rounded border border-neutral-700 bg-neutral-950"
            />
          </label>
          <NumberField
            label="Border width"
            value={element.strokeWidth}
            onChange={(strokeWidth) =>
              patch((el) => (el.kind === "shape" ? { ...el, strokeWidth } : el))
            }
          />
          {element.strokeWidth > 0 && (
            <label className={label}>
              Border color
              <input
                type="color"
                value={element.stroke ?? "#111827"}
                onChange={(e) =>
                  patch((el) => (el.kind === "shape" ? { ...el, stroke: e.target.value } : el))
                }
                className="mt-0.5 h-7 w-full rounded border border-neutral-700 bg-neutral-950"
              />
            </label>
          )}
        </Section>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const deck = useDeckStore((s) => s.deck);
  const current = useDeckStore((s) => s.currentSlide);
  const selectedIds = useDeckStore((s) => s.selectedElementIds);
  const setSlideLayout = useDeckStore((s) => s.setSlideLayout);
  const setTheme = useDeckStore((s) => s.setTheme);
  const setThemeBackground = useDeckStore((s) => s.setThemeBackground);
  const setSlideBackground = useDeckStore((s) => s.setSlideBackground);
  const updateSlide = useDeckStore((s) => s.updateSlide);

  if (!deck) return null;
  const slide = deck.slides[current];
  // Computed here rather than through a selector: `filter` returns a fresh
  // array, which Zustand's Object.is comparison would treat as a change on
  // every render.
  const selected = (slide?.elements ?? []).filter((el) => selectedIds.includes(el.id));

  return (
    <aside className="flex h-full w-64 flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-900">
      {selected.length > 1 ? (
        <MultiSelectionProps elements={selected} />
      ) : selected.length === 1 ? (
        <ElementProps element={selected[0]!} />
      ) : (
        <>
          <Section title="Slide">
            <div className="text-[11px] text-neutral-500">
              Format: 16:9 · {SLIDE_W}×{SLIDE_H}
            </div>
            {slide && (
              <>
                <label className={label}>
                  Name
                  <input
                    value={slide.name}
                    onChange={(e) => updateSlide(current, (s) => ({ ...s, name: e.target.value }))}
                    className={`${field} mt-0.5`}
                  />
                </label>
                <div>
                  <span className={label}>
                    Background{" "}
                    {slide.background === undefined && (
                      <span className="text-neutral-600">(inherited from theme)</span>
                    )}
                  </span>
                  <div className="mt-1">
                    <BackgroundEditor
                      value={slide.background ?? deck.theme.background}
                      fallbackColor={
                        deck.theme.background.kind === "color" ? deck.theme.background.color : "#ffffff"
                      }
                      onChange={(background) => setSlideBackground(current, background)}
                      onInherit={
                        slide.background === undefined
                          ? undefined
                          : () => setSlideBackground(current, undefined)
                      }
                      inheritLabel="Use theme"
                    />
                  </div>
                </div>
                <label className={label}>
                  Speaker notes
                  <textarea
                    rows={3}
                    value={slide.notes ?? ""}
                    onChange={(e) =>
                      updateSlide(current, (s) => ({ ...s, notes: e.target.value || undefined }))
                    }
                    className={`${field} mt-0.5 resize-y`}
                    placeholder="Not shown on the slide"
                  />
                </label>
              </>
            )}
          </Section>

          <Section title="Layouts">
            <div className="grid grid-cols-3 gap-1.5">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  title={l.label}
                  disabled={!slide}
                  onClick={() => setSlideLayout(current, l.id)}
                  className={`aspect-[16/10] rounded border-2 p-1 disabled:opacity-30 ${
                    slide?.layout === l.id
                      ? "border-sky-500 bg-neutral-800"
                      : "border-neutral-700 bg-neutral-950 hover:border-neutral-500"
                  }`}
                >
                  <LayoutGlyph id={l.id} />
                </button>
              ))}
            </div>
          </Section>

          <Section title="Master / theme">
            <div className="space-y-1">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.preset}
                  onClick={() => setTheme(preset)}
                  className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-[11px] ${
                    deck.theme.preset === preset.preset
                      ? "border-sky-500 text-neutral-100"
                      : "border-neutral-700 text-neutral-400 hover:border-neutral-600"
                  }`}
                >
                  <span
                    className="h-4 w-6 flex-shrink-0 rounded-sm border border-black/30"
                    style={{
                      // Presets are all flat colors today, but `background` is a
                      // union now — don't hand an object to CSS if that changes.
                      background:
                        preset.background.kind === "color" ? preset.background.color : "#555",
                    }}
                  >
                    <span
                      className="ml-0.5 mt-0.5 block h-1 w-3 rounded-sm"
                      style={{ background: preset.accent }}
                    />
                  </span>
                  {preset.label}
                </button>
              ))}
            </div>
            <div>
              <span className={label}>Background (all slides)</span>
              <div className="mt-1">
                <BackgroundEditor
                  value={deck.theme.background}
                  fallbackColor={
                    deck.theme.background.kind === "color" ? deck.theme.background.color : "#ffffff"
                  }
                  onChange={setThemeBackground}
                />
              </div>
            </div>
            <label className={label}>
              Text color
              <input
                type="color"
                value={deck.theme.text}
                onChange={(e) => setTheme({ text: e.target.value, preset: "custom" })}
                className="mt-0.5 h-7 w-full rounded border border-neutral-700 bg-neutral-950"
              />
            </label>
          </Section>
        </>
      )}
    </aside>
  );
}

/** Tiny wireframe preview of a layout, like Impress's layout swatches. */
function LayoutGlyph({ id }: { id: string }) {
  const bar = "bg-sky-500/70 rounded-[1px]";
  if (id === "blank") return <div className="h-full w-full" />;
  if (id === "title") return <div className={`${bar} h-1.5 w-full`} />;
  if (id === "centered")
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1">
        <div className={`${bar} h-1.5 w-3/4`} />
        <div className={`${bar} h-1 w-1/2 opacity-60`} />
      </div>
    );
  if (id === "contentOnly") return <div className={`${bar} h-full w-full opacity-50`} />;
  if (id === "titleTwoContent")
    return (
      <div className="flex h-full w-full flex-col gap-1">
        <div className={`${bar} h-1.5 w-full`} />
        <div className="flex flex-1 gap-1">
          <div className={`${bar} flex-1 opacity-50`} />
          <div className={`${bar} flex-1 opacity-50`} />
        </div>
      </div>
    );
  return (
    <div className="flex h-full w-full flex-col gap-1">
      <div className={`${bar} h-1.5 w-full`} />
      <div className={`${bar} flex-1 opacity-50`} />
    </div>
  );
}
