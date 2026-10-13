import { describe, expect, it } from "vitest";
import { suggestionMessage } from "./AutoSuggestCues.js";

describe("suggestionMessage", () => {
  it("says the music timed the cues, and why, when lyric timing fell back", () => {
    const line = suggestionMessage({ source: "music", note: "none of the lyrics could be found in the recording" }, 5, 5);
    expect(line).toContain("Timed from the music alone");
    expect(line).toContain("none of the lyrics could be found in the recording");
  });
  it("says the music timed the cues when there was nothing to fall back from", () => {
    expect(suggestionMessage({ source: "music" }, 5, 5)).toContain("Timed from the music alone.");
  });
  it("does not claim music timing when the lyrics were used", () => {
    const line = suggestionMessage({ source: "lyrics" }, 5, 5);
    expect(line).toContain("Timed from the lyrics.");
    expect(line).not.toMatch(/music/);
  });
  it("counts the slides left uncued", () => {
    expect(suggestionMessage({ source: "music" }, 3, 7)).toContain("Found 3 distinct parts for 7 slides");
    expect(suggestionMessage({ source: "music" }, 7, 7)).toContain("Cued every slide.");
  });
});
