import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { trackGesture } from "./SlideCanvas.js";

function gesture() {
  const target = new EventTarget();
  const classes = new Set<string>();
  const root = { classList: { add: (t: string) => void classes.add(t), remove: (t: string) => void classes.delete(t) } };
  const onMove = vi.fn();
  const onEnd = vi.fn();
  trackGesture(onMove, onEnd, target, root);
  return { target, selectable: () => !classes.has("select-none"), onMove, onEnd };
}

describe("trackGesture", () => {
  it("suppresses text selection while the drag runs and restores it on pointerup", () => {
    const g = gesture();
    expect(g.selectable()).toBe(false);
    g.target.dispatchEvent(new Event("pointermove"));
    expect(g.onMove).toHaveBeenCalledTimes(1);
    g.target.dispatchEvent(new Event("pointerup"));
    expect(g.selectable()).toBe(true);
    expect(g.onEnd).toHaveBeenCalledTimes(1);
  });

  it.each(["pointercancel", "blur"])("restores selection when the gesture ends abnormally by %s", (type) => {
    const g = gesture();
    g.target.dispatchEvent(new Event(type));
    expect(g.selectable()).toBe(true);
    expect(g.onEnd).toHaveBeenCalledTimes(1);
  });

  it("stops listening once ended, so a later pointer event neither moves nor ends it again", () => {
    const g = gesture();
    g.target.dispatchEvent(new Event("pointercancel"));
    g.target.dispatchEvent(new Event("pointermove"));
    g.target.dispatchEvent(new Event("pointerup"));
    expect(g.onMove).not.toHaveBeenCalled();
    expect(g.onEnd).toHaveBeenCalledTimes(1);
  });
});

// The overlay's own contract is CLAUDE.md's Traps section; these pin only that the control layer stayed out of it.
describe("the inline editor overlay", () => {
  const source = readFileSync(new URL("./SlideCanvas.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{/* Inline editing, for text and tab elements alike.");
  const overlay = source.slice(start, source.indexOf("{/* Placeholder hints", start));

  it("is still a plain textarea, not a Field", () => {
    expect(overlay).toContain("<textarea");
    expect(overlay).not.toMatch(/<Field|<Button|className/);
  });

  it("keeps the inline outline:none that beats the global focus ring, and its own outline ring", () => {
    expect(overlay).toContain('outline: "none"');
    expect(overlay).toContain("solid var(--color-accent)");
  });

  it("has no motion", () => {
    expect(overlay).not.toMatch(/transition|animation|transform/);
  });
});
