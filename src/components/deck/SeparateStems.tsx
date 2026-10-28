import { useEffect, useRef, useState } from "react";
import { isModelCached, separateTrack, type SeparateProgress } from "../../audio/separate.js";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * Runs Demucs on the deck's track and stores the resulting stems.
 *
 * The download is announced *before* it starts. A first run silently pulling
 * 172MB and then grinding for minutes is indistinguishable from the app
 * having hung, so the size, the cache state and the segment counter are all
 * surfaced.
 */
export function SeparateStems() {
  const deck = useDeckStore((s) => s.deck);
  const adapter = useDeckStore((s) => s.adapter);
  const attachStems = useDeckStore((s) => s.attachStems);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SeparateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<boolean | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    void isModelCached().then(setCached);
  }, []);

  if (!deck?.audio || deck.audio.stems) return null;

  async function run() {
    if (!deck?.audio) return;
    cancelledRef.current = false;
    setRunning(true);
    setError(null);
    try {
      const blob = await adapter.readDeckAsset(deck.id, deck.audio.path);
      const stems = await separateTrack(await blob.arrayBuffer(), setProgress);
      if (cancelledRef.current) return;
      await attachStems(stems.map((s) => ({ id: s.id, data: s.data, ext: s.ext })));
      setCached(true);
    } catch (err) {
      if (!cancelledRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const label: Record<SeparateProgress["stage"], string> = {
    downloading: "Downloading model",
    loading: "Loading model",
    separating: "Separating",
    encoding: "Saving stems",
  };

  return (
    <div className="border-t border-line px-3 py-2">
      {!running ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void run()}
            className="rounded bg-raised px-2 py-0.5 text-xs text-fg hover:bg-raised-hover"
          >
            Separate stems
          </button>
          <span className="text-[11px] text-faint">
            Splits the track into drums, bass, vocals and other, so you can mute or solo
            each one.
            {cached === false && " First run downloads a ~172MB model."}
            {cached === true && " Model already downloaded."}
          </span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>{progress ? label[progress.stage] : "Starting"}…</span>
            {progress?.detail && <span className="text-faint">{progress.detail}</span>}
            <button
              onClick={() => {
                // Inference can't actually be interrupted mid-segment; this
                // stops the result being written and lets the UI recover.
                cancelledRef.current = true;
                setRunning(false);
              }}
              className="ml-auto text-faint hover:text-danger"
            >
              Cancel
            </button>
          </div>
          <div className="h-1 overflow-hidden rounded bg-raised">
            <div
              className="h-full bg-accent transition-[width]"
              style={{
                width: progress?.fraction != null ? `${Math.round(progress.fraction * 100)}%` : "100%",
                opacity: progress?.fraction == null ? 0.4 : 1,
              }}
            />
          </div>
          <p className="text-[10px] text-faint">
            This takes several minutes and works the CPU hard. Keep this tab open.
          </p>
        </div>
      )}

      {error && (
        <p className="mt-1 rounded border border-danger-soft bg-danger-soft px-2 py-1 text-[11px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
