import { describe, expect, it } from "vitest";
import { measureEditor, type MeasurableField } from "./measureEditor.js";

/**
 * A textarea whose scroll size only reveals its content once collapsed: at any larger size
 * it reports that size back, which is why measuring has to collapse first.
 */
function field(content: { w: number; h: number }, style = { width: "560px", height: "156px" }): MeasurableField & { reads: string[] } {
  const px = (v: string) => (v.endsWith("px") ? parseFloat(v) : 0);
  const reads: string[] = [];
  return {
    style: { ...style },
    reads,
    get scrollHeight() { reads.push(`h@${this.style.height}`); return this.style.height === "auto" ? content.h : Math.max(content.h, px(this.style.height)); },
    get scrollWidth() { reads.push(`w@${this.style.width}`); return Math.max(content.w, px(this.style.width)); },
  };
}

describe("measureEditor", () => {
  it("leaves the inline size React rendered, so an unchanged size isn't stuck at 1px/auto", () => {
    const tab = field({ w: 300, h: 156 });
    measureEditor(tab, true);
    expect(tab.style).toEqual({ width: "560px", height: "156px" });
  });

  it("measures collapsed, so a box that grew can shrink back to its content", () => {
    const tab = field({ w: 300, h: 120 }, { width: "1072px", height: "156px" });
    expect(measureEditor(tab, true)).toEqual({ width: 300, height: 120 });
    expect(tab.reads).toEqual(["h@auto", "w@1px"]);
  });

  it("grows past the box for a line longer than it", () => {
    expect(measureEditor(field({ w: 1072, h: 156 }), true)).toEqual({ width: 1072, height: 156 });
  });

  it("leaves width alone for text, which wraps instead", () => {
    const text = field({ w: 900, h: 161 }, { width: "100%", height: "161px" });
    expect(measureEditor(text, false)).toEqual({ width: null, height: 161 });
    expect(text.style).toEqual({ width: "100%", height: "161px" });
    expect(text.reads).toEqual(["h@auto"]);
  });
});
