import { LAYOUTS, THEME_PRESETS, padTabLines } from "../../deck/templates.js";
import { boundsOf } from "../../deck/geometry.js";
import { SLIDE_H, SLIDE_W, type SlideElement } from "../../schema/deck.js";
import { useDeckStore } from "../../store/deckStore.js";
import { BackgroundEditor } from "./BackgroundEditor.js";
import { Button, Field } from "../controls.js";

/**
 * The right rail — the Properties sidebar from Impress: slide format,
 * background, master/theme, layouts; plus the selected element's own
 * properties, which Impress splits across several dialogs.
 */

const label = "block text-[11px] text-faint";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-3 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
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
      <Field
        size="sm"
        type="number"
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="mt-0.5 w-full"
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

  return (
    <>
      <Section title={`${elements.length} elements selected`}>
        {bounds && (
          <div className="text-[11px] text-faint">
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
            <Button size="sm" key={mode} title={title} onClick={() => alignSelection(mode)}>
              {title.replace("Align ", "").replace("Centre ", "C·")}
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          <Button size="sm" className="flex-1"
            disabled={elements.length < 3}
            onClick={() => distributeSelection("horizontal")}
            title="Needs three or more"
          >
            Distribute H
          </Button>
          <Button size="sm" className="flex-1"
            disabled={elements.length < 3}
            onClick={() => distributeSelection("vertical")}
            title="Needs three or more"
          >
            Distribute V
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" onClick={() => arrangeSelection("front")}>
            Bring to front
          </Button>
          <Button size="sm" onClick={() => arrangeSelection("back")}>
            Send to back
          </Button>
          <Button size="sm" onClick={() => arrangeSelection("forward")}>
            Forward
          </Button>
          <Button size="sm" onClick={() => arrangeSelection("backward")}>
            Backward
          </Button>
        </div>
        <Button size="sm" className="w-full" onClick={duplicateSelection}>
          Duplicate (Ctrl+D)
        </Button>
        <label className="flex items-center gap-2 pt-1 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={allLocked}
            onChange={(e) => updateSelection((el) => ({ ...el, locked: e.target.checked }))}
          />
          Lock position
        </label>
        <Button variant="destructive" size="sm" className="w-full"
          onClick={deleteSelection}
        >
          Delete {elements.length} elements
        </Button>
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
        <label className="flex items-center gap-2 pt-1 text-[11px] text-muted">
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
            <Button size="sm"
              key={mode}
              title={`Align ${mode} on the slide`}
              onClick={() => alignSelection(mode, "slide")}
            >
              {text}
            </Button>
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
            <Button size="sm"
              key={direction}
              onClick={() => reorderElement(element.id, direction)}
            >
              {text}
            </Button>
          ))}
        </div>
        <Button variant="destructive" size="sm" className="w-full"
          onClick={() => deleteElement(element.id)}
        >
          Delete element
        </Button>
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
              <Button size="sm" className="flex-1" pressed={!!element.style[k]}
                key={k}
                aria-label={k[0]!.toUpperCase() + k.slice(1)}
                onClick={() =>
                  patch((el) =>
                    el.kind === "text" ? { ...el, style: { ...el.style, [k]: !el.style[k] } } : el,
                  )
                }
              >
                {k === "bold" ? "B" : k === "italic" ? "I" : "U"}
              </Button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["left", "center", "right"] as const).map((a) => (
              <Button size="sm" className="flex-1" pressed={element.style.align === a}
                key={a}
                onClick={() =>
                  patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, align: a } } : el))
                }
              >
                {a}
              </Button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["top", "middle", "bottom"] as const).map((v) => (
              <Button size="sm" className="flex-1" pressed={element.style.valign === v}
                key={v}
                onClick={() =>
                  patch((el) => (el.kind === "text" ? { ...el, style: { ...el.style, valign: v } } : el))
                }
              >
                {v}
              </Button>
            ))}
          </div>
          <label className={label}>
            Color (blank = theme)
            <div className="mt-0.5 flex gap-1">
              <Field
                size="sm"
                type="color"
                value={element.style.color ?? "#111827"}
                onChange={(e) =>
                  patch((el) =>
                    el.kind === "text" ? { ...el, style: { ...el.style, color: e.target.value } } : el,
                  )
                }
                className="w-10"
              />
              <Button size="sm" className="flex-1"
                onClick={() =>
                  patch((el) => {
                    if (el.kind !== "text") return el;
                    const { color: _drop, ...style } = el.style;
                    return { ...el, style };
                  })
                }
              >
                Use theme
              </Button>
            </div>
          </label>
        </Section>
      )}

      {element.kind === "tab" && (
        <Section title="Tab">
          <Button size="sm" className="w-full"
            title="Pad every line to the same length with trailing dashes, so the diagram forms a clean rectangle instead of a ragged edge"
            onClick={() =>
              patch((el) => (el.kind === "tab" ? { ...el, text: padTabLines(el.text) } : el))
            }
          >
            Complete — even out line lengths
          </Button>
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
              <Button size="sm" className="flex-1" pressed={element.style.valign === v}
                key={v}
                onClick={() =>
                  patch((el) => (el.kind === "tab" ? { ...el, style: { ...el.style, valign: v } } : el))
                }
              >
                {v}
              </Button>
            ))}
          </div>
          <label className={label}>
            Color (blank = theme)
            <div className="mt-0.5 flex gap-1">
              <Field
                size="sm"
                type="color"
                value={element.style.color ?? "#111827"}
                onChange={(e) =>
                  patch((el) =>
                    el.kind === "tab" ? { ...el, style: { ...el.style, color: e.target.value } } : el,
                  )
                }
                className="w-10"
              />
              <Button size="sm" className="flex-1"
                onClick={() =>
                  patch((el) => {
                    if (el.kind !== "tab") return el;
                    const { color: _drop, ...style } = el.style;
                    return { ...el, style };
                  })
                }
              >
                Use theme
              </Button>
            </div>
          </label>
        </Section>
      )}

      {element.kind === "image" && (
        <Section title="Image">
          <label className={label}>
            Fit
            <Field
              as="select"
              size="sm"
              value={element.fit}
              onChange={(e) =>
                patch((el) =>
                  el.kind === "image" ? { ...el, fit: e.target.value as typeof el.fit } : el,
                )
              }
              className="mt-0.5 w-full"
            >
              <option value="contain">contain</option>
              <option value="cover">cover</option>
              <option value="fill">fill</option>
            </Field>
          </label>
          <p className="truncate text-[10px] text-faint" title={element.src}>
            {element.src}
          </p>
        </Section>
      )}

      {element.kind === "shape" && (
        <Section title="Shape">
          <label className={label}>
            Shape
            <Field
              as="select"
              size="sm"
              value={element.shape}
              onChange={(e) =>
                patch((el) =>
                  el.kind === "shape" ? { ...el, shape: e.target.value as typeof el.shape } : el,
                )
              }
              className="mt-0.5 w-full"
            >
              <option value="rect">Rectangle</option>
              <option value="roundRect">Rounded rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="line">Line</option>
              <option value="arrow">Arrow</option>
            </Field>
          </label>
          <label className={label}>
            Fill
            <Field
              size="sm"
              type="color"
              value={element.fill ?? "#2563eb"}
              onChange={(e) =>
                patch((el) => (el.kind === "shape" ? { ...el, fill: e.target.value } : el))
              }
              className="mt-0.5 w-full"
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
              <Field
                size="sm"
                type="color"
                value={element.stroke ?? "#111827"}
                onChange={(e) =>
                  patch((el) => (el.kind === "shape" ? { ...el, stroke: e.target.value } : el))
                }
                className="mt-0.5 w-full"
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
    <aside className="flex h-full w-64 flex-col overflow-y-auto border-l border-line bg-panel">
      {selected.length > 1 ? (
        <MultiSelectionProps elements={selected} />
      ) : selected.length === 1 ? (
        <ElementProps element={selected[0]!} />
      ) : (
        <>
          <Section title="Slide">
            <div className="text-[11px] text-faint">
              Format: 16:9 · {SLIDE_W}×{SLIDE_H}
            </div>
            {slide && (
              <>
                <label className={label}>
                  Name
                  <Field
                    size="sm"
                    value={slide.name}
                    onChange={(e) => updateSlide(current, (s) => ({ ...s, name: e.target.value }))}
                    className="mt-0.5 w-full"
                  />
                </label>
                <div>
                  <span className={label}>
                    Background{" "}
                    {slide.background === undefined && (
                      <span className="text-faint">(inherited from theme)</span>
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
                  <Field
                    as="textarea"
                    size="sm"
                    rows={3}
                    value={slide.notes ?? ""}
                    onChange={(e) =>
                      updateSlide(current, (s) => ({ ...s, notes: e.target.value || undefined }))
                    }
                    className="mt-0.5 w-full resize-y"
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
                  aria-label={l.label}
                  aria-pressed={slide?.layout === l.id}
                  disabled={!slide}
                  onClick={() => setSlideLayout(current, l.id)} className="tile aspect-[16/10] p-1 disabled:opacity-30"
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
                  aria-pressed={deck.theme.preset === preset.preset}
                  onClick={() => setTheme(preset)} className="tile flex w-full items-center gap-2 px-2 py-1 text-left text-[11px]"
                >
                  <span
                    className="h-4 w-6 flex-shrink-0 rounded-[1px] border border-line"
                    style={{
                      // Presets are all flat colors today, but `background` is a
                      // union now — don't hand an object to CSS if that changes.
                      background:
                        preset.background.kind === "color" ? preset.background.color : "var(--color-raised)",
                    }}
                  >
                    <span
                      className="ml-0.5 mt-0.5 block h-1 w-3 rounded-[1px]"
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
              <Field
                size="sm"
                type="color"
                value={deck.theme.text}
                onChange={(e) => setTheme({ text: e.target.value, preset: "custom" })}
                className="mt-0.5 w-full"
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
  const bar = "bg-accent rounded-[1px]";
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
