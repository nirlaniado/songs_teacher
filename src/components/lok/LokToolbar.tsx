import {
  deleteSlide,
  duplicateSlide,
  exportAs,
  unoCommand,
  type UnoCommand,
} from "../../lok/client.js";

/**
 * A representative slice of Impress's own toolbar, not an exhaustive port —
 * Stage 3's job was proving `.uno:` dispatch works as a real command layer,
 * which one button per command family already demonstrates. Every button
 * here maps to a symbolic name in lok/server/index.ts's UNO_COMMANDS (or a
 * dedicated slide-index route for duplicate/delete); see LokCanvas.tsx's
 * module comment for which of the underlying commands are pixel-verified
 * versus asserted from UNO's long-stable naming conventions.
 */
export interface LokToolbarProps {
  slideIndex: number;
  slideCount: number;
  onSlideMutated: () => void;
  onRerender: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

export function LokToolbar({
  slideIndex,
  slideCount,
  onSlideMutated,
  onRerender,
  busy,
  setBusy,
}: LokToolbarProps) {
  async function run(command: UnoCommand) {
    setBusy(true);
    try {
      await unoCommand(command);
      onRerender();
    } finally {
      setBusy(false);
    }
  }

  async function runDuplicate() {
    setBusy(true);
    try {
      await duplicateSlide(slideIndex);
      onSlideMutated();
    } finally {
      setBusy(false);
    }
  }

  async function runDelete() {
    if (slideCount <= 1) return;
    setBusy(true);
    try {
      await deleteSlide(slideIndex);
      onSlideMutated();
    } finally {
      setBusy(false);
    }
  }

  async function runExport(format: "odp" | "pptx" | "pdf") {
    setBusy(true);
    try {
      const blob = await exportAs(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `presentation.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded px-2 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-2 py-1">
      <button className={btn} disabled={busy} onClick={() => void run("bold")} title=".uno:Bold">
        <strong>B</strong>
      </button>
      <button className={btn} disabled={busy} onClick={() => void run("italic")} title=".uno:Italic">
        <em>I</em>
      </button>
      <button className={btn} disabled={busy} onClick={() => void run("underline")} title=".uno:Underline">
        <span className="underline">U</span>
      </button>
      <div className="mx-1 h-4 w-px bg-neutral-700" />
      <button className={btn} disabled={busy} onClick={() => void run("undo")}>
        ↶ Undo
      </button>
      <button className={btn} disabled={busy} onClick={() => void run("redo")}>
        ↷ Redo
      </button>
      <div className="mx-1 h-4 w-px bg-neutral-700" />
      <button className={btn} disabled={busy} onClick={() => void run("startInsertTextBox")} title=".uno:Text — then drag on the slide">
        + Text
      </button>
      <button className={btn} disabled={busy} onClick={() => void run("startDrawRectangle")} title=".uno:Rect — then drag on the slide">
        ▭ Rect
      </button>
      <button className={btn} disabled={busy} onClick={() => void run("deleteSelection")}>
        🗑 Delete
      </button>
      <div className="mx-1 h-4 w-px bg-neutral-700" />
      <button className={btn} disabled={busy} onClick={() => void runDuplicate()}>
        ⎘ Duplicate slide
      </button>
      <button className={btn} disabled={busy || slideCount <= 1} onClick={() => void runDelete()}>
        Delete slide
      </button>
      <div className="mx-1 h-4 w-px bg-neutral-700" />
      <button className={btn} disabled={busy} onClick={() => void runExport("pptx")}>
        Export PPTX
      </button>
      <button className={btn} disabled={busy} onClick={() => void runExport("odp")}>
        Export ODP
      </button>
      <button className={btn} disabled={busy} onClick={() => void runExport("pdf")}>
        Export PDF
      </button>
    </div>
  );
}
