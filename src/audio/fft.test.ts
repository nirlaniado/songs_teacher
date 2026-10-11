import { describe, expect, it } from "vitest";
import { fft } from "./fft.js";

describe("fft", () => {
  it("puts a pure sine in the expected bin", () => {
    const n = 1024;
    const bin = 37;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * bin * i) / n);
    fft(re, im);
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]!));
    const peak = mags.indexOf(Math.max(...mags.slice(0, n / 2)));
    expect(peak).toBe(bin);
    // A pure on-bin sine has magnitude n/2 there and ~0 elsewhere.
    expect(mags[bin]).toBeCloseTo(n / 2, 3);
    expect(mags[bin + 5]).toBeLessThan(1e-6);
  });

  it("transforms an impulse into a flat spectrum", () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[0] = 1;
    fft(re, im);
    for (let i = 0; i < 8; i++) {
      expect(re[i]).toBeCloseTo(1, 10);
      expect(im[i]).toBeCloseTo(0, 10);
    }
  });

  it("rejects a length that is not a power of two", () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });
});
