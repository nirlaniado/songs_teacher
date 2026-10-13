import { describe, expect, it } from "vitest";
import { Slide } from "../../schema/deck.js";
import { cueWarnings } from "./TimingPanel.js";

const slides = (...times: Array<number | undefined>) =>
  times.map((startTime) => Slide.parse({ id: crypto.randomUUID(), ...(startTime === undefined ? {} : { startTime }) }));

describe("cueWarnings", () => {
  it("flags a cued slide on the same instant as the cued slide before it", () => {
    const { sameTimeAs, outOfOrder } = cueWarnings(slides(0, 0, 20, undefined, 20, 40));
    expect([...sameTimeAs]).toEqual([[1, 0], [4, 2]]);
    expect(outOfOrder.size).toBe(0);
  });
  it("flags every later slide sharing the time, pointing at the first", () => {
    expect([...cueWarnings(slides(0, 0, 0)).sameTimeAs]).toEqual([[1, 0], [2, 0]]);
  });
  it("does not flag distinct times or uncued slides", () => {
    const { sameTimeAs, outOfOrder } = cueWarnings(slides(0, undefined, 10, undefined, undefined, 30));
    expect(sameTimeAs.size).toBe(0);
    expect(outOfOrder.size).toBe(0);
  });
  it("keeps flagging backward cues as out of order, not as shared", () => {
    const { sameTimeAs, outOfOrder } = cueWarnings(slides(0, 30, 10));
    expect([...outOfOrder]).toEqual([2]);
    expect(sameTimeAs.size).toBe(0);
  });
});
