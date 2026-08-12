import { describe, expect, it } from "vitest";
import { assertRelativeSegments } from "./paths.js";
import { LibraryError } from "./types.js";

describe("assertRelativeSegments", () => {
  it("splits a simple relative path into segments", () => {
    expect(assertRelativeSegments("audio.mp3")).toEqual(["audio.mp3"]);
    expect(assertRelativeSegments("assets/diagram.png")).toEqual(["assets", "diagram.png"]);
  });

  it("normalizes backslashes and drops empty/dot segments", () => {
    expect(assertRelativeSegments("assets\\take2.flac")).toEqual(["assets", "take2.flac"]);
    expect(assertRelativeSegments("./assets//diagram.png")).toEqual(["assets", "diagram.png"]);
  });

  it("rejects absolute unix paths", () => {
    expect(() => assertRelativeSegments("/etc/passwd")).toThrow(LibraryError);
  });

  it("rejects absolute windows paths", () => {
    expect(() => assertRelativeSegments("C:\\Windows\\System32")).toThrow(LibraryError);
  });

  it("rejects paths that escape the root via ..", () => {
    expect(() => assertRelativeSegments("../other-song/audio.mp3")).toThrow(LibraryError);
    expect(() => assertRelativeSegments("assets/../../escape")).toThrow(LibraryError);
  });

  it("tags the thrown error with the out-of-root code", () => {
    try {
      assertRelativeSegments("/etc/passwd");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe("out-of-root");
    }
  });
});
