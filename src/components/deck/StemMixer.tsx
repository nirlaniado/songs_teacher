import { clearSolos, isSilent, setStemGain, sortStems, STEM_LABEL, toggleStem } from "../../audio/mix.js";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * Per-instrument mute / solo / volume for a separated song.
 *
 * Only rendered when the deck actually has stems, so a normal deck's Music
 * sync panel is unchanged.
 */
export function StemMixer() {
  const stemMix = useDeckStore((s) => s.stemMix);
  const setStemMix = useDeckStore((s) => s.setStemMix);
  const removeStems = useDeckStore((s) => s.removeStems);

  if (stemMix.length === 0) return null;

  const ordered = sortStems(stemMix);
  const soloing = stemMix.some((s) => s.soloed);
  const silent = isSilent(stemMix);

  return (
    <div className="border-t border-neutral-800 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Stems
        </span>
        {silent && (
          <span className="text-[10px] text-amber-500">everything is muted — no sound</span>
        )}
        {soloing && (
          <button
            onClick={() => setStemMix(clearSolos(stemMix))}
            className="text-[10px] text-sky-400 hover:text-sky-300"
          >
            clear solo
          </button>
        )}
        <button
          onClick={() => {
            if (confirm("Remove the separated stems? The full mix is kept.")) void removeStems();
          }}
          className="ml-auto text-[10px] text-neutral-600 hover:text-red-400"
        >
          Remove stems
        </button>
      </div>

      <div className="space-y-1">
        {ordered.map((stem) => {
          // While anything is soloed, an unsoloed stem is inaudible whatever
          // its own mute flag says — dim it so the row matches what you hear.
          const audible = soloing ? stem.soloed : !stem.muted;
          return (
            <div key={stem.id} className="flex items-center gap-2">
              <span
                className={`w-14 text-[11px] ${audible ? "text-neutral-200" : "text-neutral-600"}`}
              >
                {STEM_LABEL[stem.id]}
              </span>

              <button
                onClick={() => setStemMix(toggleStem(stemMix, stem.id, "muted"))}
                title="Mute"
                className={`w-6 rounded px-1 py-0.5 text-[10px] font-medium ${
                  stem.muted ? "bg-red-800 text-white" : "bg-neutral-800 text-neutral-400"
                }`}
              >
                M
              </button>
              <button
                onClick={() => setStemMix(toggleStem(stemMix, stem.id, "soloed"))}
                title="Solo"
                className={`w-6 rounded px-1 py-0.5 text-[10px] font-medium ${
                  stem.soloed ? "bg-amber-600 text-white" : "bg-neutral-800 text-neutral-400"
                }`}
              >
                S
              </button>

              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={stem.gain}
                onChange={(e) => setStemMix(setStemGain(stemMix, stem.id, Number(e.target.value)))}
                className="h-1 flex-1 accent-sky-500"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
