import { describe, expect, it, vi } from "vitest";
import { cleanSegments, transcribeAudio } from "./transcribe.js";

describe("cleanSegments", () => {
  it("keeps well-formed phrases, rounded to a tenth, and trims the text", () => {
    expect(cleanSegments([{ start: 1.234, end: 3.96, text: "  hello there " }])).toEqual([{ start: 1.2, end: 4, text: "hello there" }]);
  });

  it("drops malformed, empty, negative and backwards entries", () => {
    expect(cleanSegments([
      { start: "1", end: 2, text: "x" },
      { start: -1, end: 2, text: "x" },
      { start: 5, end: 2, text: "x" },
      { start: 1, end: 2, text: "   " },
      { start: 1, end: 2 },
      { start: 0, end: 1, text: "kept" },
    ])).toEqual([{ start: 0, end: 1, text: "kept" }]);
  });
});

describe("transcribeAudio", () => {
  it("returns cleaned segments and the reported duration", async () => {
    const call = vi.fn(async () => ({ duration: 200, segments: [{ start: 1, end: 2, text: "la la" }] }));
    expect(await transcribeAudio(Buffer.from("x"), call)).toEqual({ duration: 200, segments: [{ start: 1, end: 2, text: "la la" }] });
  });

  it("falls back to the last phrase's end when no duration is reported", async () => {
    const call = async () => ({ segments: [{ start: 1, end: 9, text: "la" }] });
    expect((await transcribeAudio(Buffer.from("x"), call)).duration).toBe(9);
  });

  it("passes a failure up so the caller can fall back to local analysis", async () => {
    const call = async () => { throw new Error("boom"); };
    await expect(transcribeAudio(Buffer.from("x"), call)).rejects.toThrow("boom");
  });
});
