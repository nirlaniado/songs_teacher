import { useLibraryStore } from "../store/libraryStore.js";
import { usePlayerStore } from "../store/playerStore.js";
import { SectionType, type Section } from "../schema/song.js";

const TYPES = SectionType.options;

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** One editable row: name, type, timing, and the progression that feeds the graph. */
function SectionRow({ section, active }: { section: Section; active: boolean }) {
  const updateSection = useLibraryStore((s) => s.updateSection);
  const removeSection = useLibraryStore((s) => s.removeSection);
  const selectSection = usePlayerStore((s) => s.selectSection);
  const transport = usePlayerStore((s) => s.transport);

  return (
    <li
      className={`rounded-md border p-2 ${
        active ? "border-emerald-700 bg-emerald-950/30" : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            selectSection(section.id);
            transport?.seek(section.start);
          }}
          className="flex-1 text-left text-sm font-medium text-neutral-100 hover:text-emerald-400"
          title="Jump to this section"
        >
          {section.name}
        </button>
        <span className="text-[11px] tabular-nums text-neutral-500">
          {formatTime(section.start)}–{formatTime(section.end)}
        </span>
        <button
          onClick={() => {
            if (confirm(`Delete "${section.name}"?`)) removeSection(section.id);
          }}
          className="text-xs text-neutral-600 hover:text-red-400"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={section.name}
          onChange={(e) => updateSection(section.id, (s) => ({ ...s, name: e.target.value }))}
          placeholder="Name"
          className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
        />
        <select
          value={section.type}
          onChange={(e) =>
            updateSection(section.id, (s) => ({ ...s, type: e.target.value as Section["type"] }))
          }
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <label className="mt-2 block text-[11px] text-neutral-500">
        Progression (chords, space-separated — the graph's only harmonic input)
        <input
          defaultValue={section.progression.join(" ")}
          onBlur={(e) => {
            const progression = e.target.value.trim().split(/\s+/).filter(Boolean);
            updateSection(section.id, (s) => ({ ...s, progression }));
          }}
          placeholder="C G Am F"
          className="mt-1 block w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
        />
      </label>

      <label className="mt-2 block text-[11px] text-neutral-500">
        Notes
        <textarea
          defaultValue={section.notes ?? ""}
          onBlur={(e) =>
            updateSection(section.id, (s) => ({
              ...s,
              notes: e.target.value || undefined,
            }))
          }
          rows={2}
          placeholder="Observations, markdown…"
          className="mt-1 block w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
        />
      </label>
    </li>
  );
}

export function SectionList() {
  const sections = useLibraryStore((s) => s.currentSong?.sections ?? []);
  const activeSectionId = usePlayerStore((s) => s.activeSectionId);

  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-2 text-sm font-medium text-neutral-300">
        Sections <span className="text-neutral-600">({sections.length})</span>
      </h2>
      {sections.length === 0 ? (
        <p className="text-xs text-neutral-600">
          None yet — drag on the waveform above to mark the first one.
        </p>
      ) : (
        <ul className="flex-1 space-y-2 overflow-y-auto pr-1">
          {sections.map((section) => (
            <SectionRow key={section.id} section={section} active={section.id === activeSectionId} />
          ))}
        </ul>
      )}
    </div>
  );
}
