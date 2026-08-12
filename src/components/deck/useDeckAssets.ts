import { useEffect, useState } from "react";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * Resolves image paths inside a deck to object URLs, one entry per distinct
 * path, and revokes them when they stop being used.
 *
 * Without the revoke, every image a deck has ever displayed stays pinned in
 * memory for the whole session — the same leak `AudioHandle.release()` exists
 * to prevent, and a slide deck touches far more blobs than a song does.
 */
export function useDeckAssets(paths: readonly string[]): Record<string, string> {
  const deckId = useDeckStore((s) => s.deck?.id ?? null);
  const adapter = useDeckStore((s) => s.adapter);
  const [urls, setUrls] = useState<Record<string, string>>({});

  // Sorted+joined so the effect re-runs on content change, not array identity —
  // `paths` is rebuilt every render by the caller's `.map()`.
  const key = [...paths].sort().join("␟");

  useEffect(() => {
    if (!deckId || key === "") {
      setUrls({});
      return;
    }
    let cancelled = false;
    const created: string[] = [];

    void (async () => {
      const next: Record<string, string> = {};
      for (const path of new Set(key.split("␟"))) {
        try {
          const handle = await adapter.resolveDeckMedia(deckId, path);
          if (cancelled) {
            handle.release();
            return;
          }
          next[path] = handle.url;
          created.push(handle.url);
        } catch {
          // A missing image renders as an empty frame rather than taking the
          // whole slide down.
        }
      }
      if (!cancelled) setUrls(next);
    })();

    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [deckId, key, adapter]);

  return urls;
}
