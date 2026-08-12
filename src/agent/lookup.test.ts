import { describe, expect, it } from "vitest";
import { extractSongQuery, isLookupOnlyRequest } from "./lookup.js";

describe("extractSongQuery", () => {
  it("pulls a quoted title", () => {
    expect(extractSongQuery('add metadata for "Some Song Title"')).toBe("Some Song Title");
    expect(extractSongQuery("find details about 'Another Title'")).toBe("Another Title");
  });

  it("keeps an artist written before a quoted title", () => {
    expect(
      extractSongQuery(
        'ind the metadata for avanged sevenfold "untill the end" song and create a new first slide with it',
      ),
    ).toBe("untill the end avanged sevenfold");
  });

  it("pulls a title after for/of/about", () => {
    expect(extractSongQuery("add the metadata for Some Song")).toBe("Some Song");
    expect(extractSongQuery("get details of Another Song")).toBe("Another Song");
  });

  it("keeps the artist when written as 'title by artist'", () => {
    expect(extractSongQuery("add metadata for Some Song by Some Band")).toBe(
      "Some Song by Some Band",
    );
  });

  it("stops at the destination clause instead of swallowing it", () => {
    // "…to the title slide" is where it goes, not part of what to search for.
    expect(extractSongQuery("add metadata for Some Song to the title slide")).toBe("Some Song");
    expect(extractSongQuery("add the year of Another Song to the intro")).toBe("Another Song");
  });

  it("handles 'find me <song> <artist> metadata' with no preposition at all", () => {
    // The most natural phrasing, and the one that originally fell through to
    // the providers and produced a misleading "I don't write lyrics" reply.
    expect(extractSongQuery("find me some song some band metadata")).toBe(
      "some song some band",
    );
    expect(extractSongQuery("get another title details")).toBe("another title");
    expect(extractSongQuery("look up a third song song info")).toBe("third song");
  });

  it("strips a destination clause in the no-preposition form too", () => {
    expect(extractSongQuery("find me some song metadata to the title slide")).toBe("some song");
  });

  it("returns null when there is no title to search for", () => {
    // Otherwise we'd search Genius for the word "metadata".
    expect(extractSongQuery("add metadata")).toBeNull();
    expect(extractSongQuery("set the artist")).toBeNull();
  });

  it("returns null for instructions that aren't about a song at all", () => {
    expect(extractSongQuery("create intro verse1 chorus")).toBeNull();
    expect(extractSongQuery("cue the chorus at 2:22")).toBeNull();
  });

  it("trims trailing punctuation", () => {
    expect(extractSongQuery("add metadata for Some Song.")).toBe("Some Song");
  });

  it("cuts a follow-on clause off the query", () => {
    // "…and create a new first slide with it" says what to do with the facts,
    // not which song to search for. Leaving it in searched Genius for the
    // whole sentence.
    expect(
      extractSongQuery("find the metadata for Some Song and create a new first slide with it"),
    ).toBe("Some Song");
    expect(extractSongQuery("get details of Another Song then add it to slide 1")).toBe(
      "Another Song",
    );
  });

  it("cuts a destination phrased with new/first", () => {
    expect(extractSongQuery("add metadata for Some Song to the new first slide")).toBe(
      "Some Song",
    );
  });

  it("extracts a song from an explicit web-search request with dictation typos", () => {
    expect(extractSongQuery("serch the web for avanged sevendfold untill the end song")).toBe(
      "avanged sevendfold untill the end song",
    );
  });
});

describe("lookup intent routing", () => {
  it("routes searches and information questions to a direct answer", () => {
    expect(isLookupOnlyRequest("search the web for a song")).toBe(true);
    expect(isLookupOnlyRequest("serch the internet for a song")).toBe(true);
    expect(isLookupOnlyRequest("find metadata for Some Song")).toBe(true);
  });

  it("keeps requests that place facts in the deck in the edit workflow", () => {
    expect(isLookupOnlyRequest("add metadata for Some Song to slide 1")).toBe(false);
  });

  it("treats create/make as edit verbs, not lookups", () => {
    // "find the metadata … and create a new first slide with it" is
    // unambiguously an edit; routing it as a lookup produced no slide at all.
    expect(
      isLookupOnlyRequest("find the metadata for Some Song and create a new first slide with it"),
    ).toBe(false);
    expect(isLookupOnlyRequest("look up Some Song details and make a title slide")).toBe(false);
  });
});
