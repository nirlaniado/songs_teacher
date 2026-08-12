import { useCallback, useEffect, useState } from "react";

/**
 * The Fullscreen API, wrapped so components don't each re-learn its two traps.
 *
 * 1. `requestFullscreen()` rejects outside a user gesture, and in an iframe
 *    without `allowfullscreen`. Callers must therefore treat fullscreen as a
 *    bonus, never a precondition — every screen that uses this still works
 *    when the request is refused.
 * 2. The user can leave fullscreen without telling React (Esc, F11, the
 *    browser's own chrome). Without listening for `fullscreenchange`, state
 *    says "fullscreen" while the window plainly isn't, and the exit button
 *    stops matching what the user sees.
 */
export function useFullscreen(target: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const sync = () => setActive(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const enter = useCallback(async () => {
    try {
      await target.current?.requestFullscreen?.();
    } catch {
      // Refused — the caller's layout stands on its own.
    }
  }, [target]);

  const exit = useCallback(async () => {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      // Nothing to do; `fullscreenchange` reports whatever actually happened.
    }
  }, []);

  return { active, enter, exit };
}
