import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDeckStore } from "../../store/deckStore.js";

/**
 * The canvas right-click menu.
 *
 * Impress's context menu is how most of its editing commands are actually
 * reached — the toolbar carries the common ones and the menu carries the rest,
 * scoped to whatever is under the pointer. Entries here mirror its wording and
 * shortcuts so muscle memory transfers.
 */

export interface MenuPoint {
  x: number;
  y: number;
}

interface Entry {
  label: string;
  shortcut?: string;
  run?: () => void;
  /** Renders a divider instead of a command. */
  separator?: boolean;
  disabled?: boolean;
}

export function CanvasContextMenu({ at, onClose }: { at: MenuPoint; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  const selectedIds = useDeckStore((s) => s.selectedElementIds);
  const clipboardSize = useDeckStore((s) => s.clipboard.length);
  const cutSelection = useDeckStore((s) => s.cutSelection);
  const copySelection = useDeckStore((s) => s.copySelection);
  const pasteClipboard = useDeckStore((s) => s.pasteClipboard);
  const duplicateSelection = useDeckStore((s) => s.duplicateSelection);
  const deleteSelection = useDeckStore((s) => s.deleteSelection);
  const arrangeSelection = useDeckStore((s) => s.arrangeSelection);
  const alignSelection = useDeckStore((s) => s.alignSelection);
  const distributeSelection = useDeckStore((s) => s.distributeSelection);
  const selectAllElements = useDeckStore((s) => s.selectAllElements);
  const updateSelection = useDeckStore((s) => s.updateSelection);
  const setEditingElement = useDeckStore((s) => s.setEditingElement);

  const count = selectedIds.length;
  const has = count > 0;

  // Flip the menu back on-screen when opened near an edge, so a right-click in
  // the bottom-right corner doesn't produce a menu half outside the window.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      x: Math.min(at.x, window.innerWidth - box.width - 8),
      y: Math.min(at.y, window.innerHeight - box.height - 8),
    });
  }, [at]);

  useEffect(() => {
    const dismiss = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture, so the click that dismisses doesn't also start a marquee.
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const entries: Entry[] = [
    { label: "Cut", shortcut: "Ctrl+X", run: cutSelection, disabled: !has },
    { label: "Copy", shortcut: "Ctrl+C", run: copySelection, disabled: !has },
    { label: "Paste", shortcut: "Ctrl+V", run: pasteClipboard, disabled: clipboardSize === 0 },
    { label: "Duplicate", shortcut: "Ctrl+D", run: duplicateSelection, disabled: !has },
    { separator: true, label: "" },
    { label: "Bring to front", shortcut: "Ctrl+Shift+Home", run: () => arrangeSelection("front"), disabled: !has },
    { label: "Bring forward", shortcut: "Ctrl+Shift+↑", run: () => arrangeSelection("forward"), disabled: !has },
    { label: "Send backward", shortcut: "Ctrl+Shift+↓", run: () => arrangeSelection("backward"), disabled: !has },
    { label: "Send to back", shortcut: "Ctrl+Shift+End", run: () => arrangeSelection("back"), disabled: !has },
    { separator: true, label: "" },
    { label: "Align left", run: () => alignSelection("left"), disabled: !has },
    { label: "Align centre", run: () => alignSelection("center"), disabled: !has },
    { label: "Align right", run: () => alignSelection("right"), disabled: !has },
    { label: "Align top", run: () => alignSelection("top"), disabled: !has },
    { label: "Align middle", run: () => alignSelection("middle"), disabled: !has },
    { label: "Align bottom", run: () => alignSelection("bottom"), disabled: !has },
    { separator: true, label: "" },
    // Fewer than three has nothing between the outer two to space out.
    { label: "Distribute horizontally", run: () => distributeSelection("horizontal"), disabled: count < 3 },
    { label: "Distribute vertically", run: () => distributeSelection("vertical"), disabled: count < 3 },
    { separator: true, label: "" },
    {
      label: "Edit text",
      run: () => setEditingElement(selectedIds[0] ?? null),
      disabled: count !== 1,
    },
    {
      label: "Lock position",
      run: () => updateSelection((el) => ({ ...el, locked: !el.locked })),
      disabled: !has,
    },
    { label: "Select all", shortcut: "Ctrl+A", run: selectAllElements },
    { separator: true, label: "" },
    { label: "Delete", shortcut: "Del", run: deleteSelection, disabled: !has },
  ];

  return (
    <div
      ref={ref}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-52 rounded border border-line bg-panel py-1 shadow-xl"
    >
      {entries.map((entry, i) =>
        entry.separator ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-raised" />
        ) : (
          <button
            key={entry.label}
            disabled={entry.disabled}
            onClick={() => {
              entry.run?.();
              onClose();
            }}
            className="flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[11px] text-fg hover:bg-raised disabled:text-faint disabled:hover:bg-transparent"
          >
            {entry.label}
            {entry.shortcut && <span className="text-faint">{entry.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
