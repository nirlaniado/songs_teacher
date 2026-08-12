import { describe, expect, it } from "vitest";
import { longestCommonRun, ngrams } from "./ngrams.js";

const id = (s: string) => s;

describe("ngrams", () => {
  it("slides a window of length n across the sequence", () => {
    expect(ngrams(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
  });

  it("is empty when the sequence is shorter than n", () => {
    expect(ngrams(["a", "b"], 3)).toEqual([]);
  });
});

describe("longestCommonRun", () => {
  it("finds a shared contiguous run of at least minLength", () => {
    const a = ["I", "vi", "IV", "V", "I"];
    const b = ["ii", "vi", "IV", "V", "iii"];
    const result = longestCommonRun(a, b, id, 3);
    expect(result).toEqual({ length: 3, ngram: ["vi", "IV", "V"] });
  });

  it("returns null when the longest run is shorter than minLength", () => {
    const a = ["I", "vi", "IV"];
    const b = ["vi", "IV", "I"];
    // shared runs here are length 2 ("vi","IV") — below the default minLength of 4
    expect(longestCommonRun(a, b, id)).toBeNull();
  });

  it("is order-sensitive, unlike a rotation match", () => {
    const a = ["I", "V", "vi", "IV"];
    const b = ["IV", "vi", "V", "I"]; // reversed, not rotated
    expect(longestCommonRun(a, b, id, 2)?.length ?? 0).toBeLessThan(3);
  });

  it("picks the longest of several candidate runs", () => {
    // a length-3 run (V,vi,IV) appears first, then a length-4 run (V,vi,IV,I) —
    // the longer one must win even though the shorter one is found earlier.
    const a = ["I", "V", "vi", "IV", "ii", "V", "vi", "IV", "I"];
    const b = ["V", "vi", "IV", "I"];
    const result = longestCommonRun(a, b, id, 3);
    expect(result).toEqual({ length: 4, ngram: ["V", "vi", "IV", "I"] });
  });
});
