import { useEffect, useRef, useState } from "react";
import { useDeckStore } from "../store/deckStore.js";
import { EditorToolbar } from "./deck/EditorToolbar.js";
import { PresentMode } from "./deck/PresentMode.js";
import { PropertiesPanel } from "./deck/PropertiesPanel.js";
import { SlideCanvas } from "./deck/SlideCanvas.js";
import { SlidePanel } from "./deck/SlidePanel.js";
import { TimingPanel } from "./deck/TimingPanel.js";
import { useFullscreen } from "./deck/useFullscreen.js";
import { Button } from "./controls.js";
import { Icon } from "./icons.js";

/**
 * The editor window: slide rail, canvas, properties sidebar, and the music
 * sync panel along the bottom — the Impress arrangement plus the one thing
 * Impress has no equivalent for.
 *
 * **Focus mode** is the same editor filling the screen with the music panel
 * and the app chrome dropped. Deliberately a flag on this layout rather than a
 * second editor component: forking the editor to make it bigger is the same
 * mistake as forking `SlideRenderer` to make it present, and it would mean
 * every future panel needing to be added twice.
 *
 * Present mode, by contrast, *does* replace the editor — it plays audio, and
 * layering it over a live editor would leave two players running.
 */
export function DeckScreen({ onBack }: { onBack: () => void }) {
  const deck = useDeckStore((s) => s.deck);
  const error = useDeckStore((s) => s.error);
  const isDirty = useDeckStore((s) => s.isDirty);
  const closeDeck = useDeckStore((s) => s.closeDeck);
  const saveDeck = useDeckStore((s) => s.saveDeck);
  const undo = useDeckStore((s) => s.undo);
  const redo = useDeckStore((s) => s.redo);


  const [presenting, setPresenting] = useState(false);
  const [showTiming, setShowTiming] = useState(true);
  const [focus, setFocus] = useState(false);
  /** Panel visibility, so focus mode can go further than just hiding chrome. */
  const [showRail, setShowRail] = useState(true);
  const [showProperties, setShowProperties] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(rootRef);

  /** Whether the music panel was open before focus mode hid it. */
  const timingBeforeFocus = useRef(true);

  function enterFocus() {
    setFocus(true);
    // The music panel is what focus mode exists to get out of the way; the
    // rail and sidebar are the editor, so they stay unless turned off.
    timingBeforeFocus.current = showTiming;
    setShowTiming(false);
    void fullscreen.enter();
  }

  function leaveFocus() {
    setFocus(false);
    void fullscreen.exit();
    // Put the music panel back the way it was — but only if focus mode is
    // what closed it. Re-opening it inside focus mode is a decision, and
    // undoing that on exit would be the editor arguing with the user.
    setShowTiming((current) => (current ? current : timingBeforeFocus.current));
  }

  // Leaving browser fullscreen by any route (Esc, F11, the browser's own
  // chrome) leaves focus mode too — otherwise the layout stays stripped in a
  // window that is plainly no longer fullscreen.
  //
  // Tracked as a transition rather than "focus && !active": `requestFullscreen`
  // is async, so between entering focus and the request resolving the flag is
  // still false, and testing it directly would cancel focus mode instantly.
  const wasFullscreen = useRef(false);
  useEffect(() => {
    if (fullscreen.active) {
      wasFullscreen.current = true;
      return;
    }
    if (wasFullscreen.current) {
      wasFullscreen.current = false;
      // The same exit path as the button, so leaving with Esc restores the
      // music panel too. `exit()` is a no-op once fullscreen is already gone.
      leaveFocus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaveFocus reads
    // state through updater functions, so a stale closure can't bite here.
  }, [fullscreen.active]);

  // Ctrl/Cmd shortcuts. Undo/redo are global rather than canvas-scoped so they
  // still work while focus sits in a sidebar field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Ctrl+Shift+F, not F11: browsers own F11 and won't reliably let a page
      // preventDefault it, so binding it would work on some machines only.
      // Impress has no full-screen *edit* command to borrow a key from.
      if (e.shiftKey && k === "f") {
        e.preventDefault();
        focus ? leaveFocus() : enterFocus();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        void saveDeck();
      } else if (k === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveDeck, undo, redo, focus]);

  if (!deck) return null;

  if (presenting) return <PresentMode onExit={() => setPresenting(false)} />;

  function handleBack() {
    if (isDirty() && !confirm("You have unsaved changes. Leave anyway?")) return;
    closeDeck();
    onBack();
  }

  return (
    <div ref={rootRef} className="flex h-screen flex-col bg-canvas">
      {/* App chrome. Hidden in focus mode — its whole job is getting out of
          the way of the canvas. */}
      {!focus && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1">
          <Button variant="subtle" size="sm" onClick={handleBack}>
            ← Presentations
          </Button>
          <span className="ml-auto text-[11px] text-faint">
            Double-click text to edit · Del removes · arrows nudge
          </span>
          <Button variant="subtle" size="sm" pressed={showTiming} onClick={() => setShowTiming((v) => !v)}>
            <Icon name="music" /> Music sync
          </Button>
          <Button variant="subtle" size="sm"
            onClick={enterFocus}
            title="Edit full screen, without the music panel (Ctrl+Shift+F)"
          >
            <Icon name="focus" /> Focus
          </Button>
        </div>
      )}

      <EditorToolbar onPresent={() => setPresenting(true)} />

      {/* Focus mode's own strip: what to hide, and the way out. Kept thin so
          the canvas gets the space that pulling the chrome freed up. */}
      {focus && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-0.5">
          <span className="text-[11px] text-faint">Focus — editing full screen</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="subtle" size="sm" pressed={showRail} onClick={() => setShowRail((v) => !v)}>
              Slides
            </Button>
            <Button variant="subtle" size="sm" pressed={showProperties} onClick={() => setShowProperties((v) => !v)}>
              Properties
            </Button>
            <Button variant="subtle" size="sm" pressed={showTiming} onClick={() => setShowTiming((v) => !v)}>
              <Icon name="music" /> Music sync
            </Button>
            <Button size="sm"
              onClick={leaveFocus}
              title="Leave focus mode (Ctrl+Shift+F, or Esc while full screen)"
            >
              <Icon name="exitFocus" /> Exit focus
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="border-b border-danger-soft bg-danger-soft px-3 py-1 text-xs text-danger">{error}</p>
      )}

      <div className="flex min-h-0 flex-1">
        {showRail && <SlidePanel />}
        <div className="flex min-w-0 flex-1 flex-col">
          <SlideCanvas />
          {showTiming && (
            <div className="panel-rise h-64 flex-shrink-0">
              <TimingPanel />
            </div>
          )}
        </div>
        {showProperties && <PropertiesPanel />}
      </div>
    </div>
  );
}
