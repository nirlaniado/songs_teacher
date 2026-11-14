import { clearSolos, isSilent, setStemGain, sortStems, STEM_LABEL, toggleStem } from "../../audio/mix.js";
import { useDeckStore } from "../../store/deckStore.js";
import { Button } from "../controls.js";

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
    <div className="border-t border-line px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Stems
        </span>
        {silent && (
          <span className="text-[10px] text-warning">everything is muted — no sound</span>
        )}
        {soloing && (
          <Button variant="subtle" size="sm"
            onClick={() => setStemMix(clearSolos(stemMix))}
          >
            clear solo
          </Button>
        )}
        <Button variant="destructive-subtle" size="sm" className="ml-auto"
          onClick={() => {
            if (confirm("Remove the separated stems? The full mix is kept.")) void removeStems();
          }}
        >
          Remove stems
        </Button>
      </div>

      <div className="space-y-1">
        {ordered.map((stem) => {
          // While anything is soloed, an unsoloed stem is inaudible whatever
          // its own mute flag says — dim it so the row matches what you hear.
          const audible = soloing ? stem.soloed : !stem.muted;
          return (
            <div key={stem.id} className="flex items-center gap-2">
              <span
                className={`w-14 text-[11px] ${audible ? "text-fg" : "text-faint"}`}
              >
                {STEM_LABEL[stem.id]}
              </span>

              <Button size="sm" icon pressed={stem.muted} tone="danger"
                onClick={() => setStemMix(toggleStem(stemMix, stem.id, "muted"))}
                title="Mute"
                aria-label={`Mute ${STEM_LABEL[stem.id]}`}
              >
                M
              </Button>
              <Button size="sm" icon pressed={stem.soloed} tone="warning"
                onClick={() => setStemMix(toggleStem(stemMix, stem.id, "soloed"))}
                title="Solo"
                aria-label={`Solo ${STEM_LABEL[stem.id]}`}
              >
                S
              </Button>

              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={stem.gain}
                onChange={(e) => setStemMix(setStemGain(stemMix, stem.id, Number(e.target.value)))}
                aria-label={`${STEM_LABEL[stem.id]} volume`}
                className="h-1 flex-1"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
