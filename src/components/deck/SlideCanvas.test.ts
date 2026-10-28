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
