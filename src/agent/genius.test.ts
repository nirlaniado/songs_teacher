import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanQuery, MIN_CONFIDENCE, overlap, searchSongs } from "./genius.js";

describe("cleanQuery", () => {
  it("drops a trailing request word that breaks the search", () => {
    // Measured against the live API: the query with "song" returned zero hits,
    // the same query without it returned the correct track.
    expect(cleanQuery("avanged sevenfokd untill the end song")).toBe(
      "avanged sevenfokd untill the end",
    );
  });

  it("drops other trailing request words", () => {
    expect(cleanQuery("some title track")).toBe("some title");
    expect(cleanQuery("some title tune")).toBe("some title");
    expect(cleanQuery("some title single")).toBe("some title");
  });

  it("strips several stacked noise words", () => {
    expect(cleanQuery("some title the song")).toBe("some title");
  });

  it("leaves a noise word alone when it isn't trailing", () => {
    // "Song" can be part of a real title.
    expect(cleanQuery("song for the deaf")).toBe("song for the deaf");
  });

  it("never reduces a query to nothing", () => {
    expect(cleanQuery("song")).toBe("song");
  });
});

describe("overlap", () => {
  it("scores a correct match highly despite misspellings", () => {
    // The user's own typos: "avanged"/"untill". Prefix matching keeps these
    // scoring, or a right answer would be rejected for a spelling slip.
    const score = overlap("avanged sevenfokd untill the end", "Until the End Avenged Sevenfold");
    expect(score).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("scores an unrelated collection page below the threshold", () => {
    // The exact failure: Genius indexes user collection pages as songs, and an
    // unchecked hits[0] wrote one onto a title slide.
    const score = overlap(
      "avanged sevenfokd untill the end",
      "KamZ's Music Collection DJKamZpr0",
    );
    expect(score).toBeLessThan(MIN_CONFIDENCE);
  });

  it("scores a plausible-but-wrong hit below the threshold", () => {
    // Searching just the artist previously surfaced an unrelated cover whose
    // title merely contained the band's name.
    const score = overlap(
      "avanged sevenfokd untill the end",
      "Amr Diab - Noul Er Win (Avanged Sevenfold version) Tobajin",
    );
    expect(score).toBeLessThan(MIN_CONFIDENCE);
  });

  it("is 1 when every query word is accounted for", () => {
    expect(overlap("some song title", "Some Song Title — Some Band")).toBe(1);
  });

  it("ignores short filler words", () => {
    // "the" and "of" carry no signal and shouldn't dilute the score.
    expect(overlap("the end of it", "The End")).toBe(1);
  });

  it("treats an empty query as matching, leaving Genius's own order to decide", () => {
    expect(overlap("", "Anything")).toBe(1);
  });
});

/** A Genius search payload with the fields the client actually reads. */
function hits(...songs: Array<{ id: number; title: string; artist: string; year?: string }>) {
  return {
    ok: true,
    json: async () => ({
      response: {
        hits: songs.map((s) => ({
          type: "song",
          result: {
            id: s.id,
            title: s.title,
            primary_artist: { name: s.artist },
            release_date: s.year ? `${s.year}-01-01` : undefined,
            url: `https://genius.com/${s.id}`,
          },
        })),
      },
    }),
  };
}

describe("searchSongs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ranks the real song above a plausible-looking wrong one", async () => {
    // Genius's own order put the collection page first; scoring is what
    // demotes it. Silently trusting hits[0] is how one reached a title slide.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        hits(
          { id: 1, title: "KamZ's Music Collection", artist: "DJKamZpr0" },
          { id: 2, title: "Unholy Confessions", artist: "Avenged Sevenfold", year: "2003" },
        ),
      ),
    );

    const candidates = await searchSongs("unholy confessions avanged sevenfold");
    expect(candidates[0]?.title).toBe("Unholy Confessions");
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(candidates[0]?.year).toBe("2003");
    // The id is kept so the album can be fetched for whichever one is chosen.
    expect(candidates[0]?.id).toBe(2);
  });

  it("drops hits with nothing to do with the query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hits({ id: 1, title: "Something Else Entirely", artist: "Another Band" })),
    );
    expect(await searchSongs("unholy confessions avanged sevenfold")).toEqual([]);
  });

  it("keeps weak-but-related hits, which are what the user gets asked about", async () => {
    // Below the accept threshold but worth offering: rejecting these outright
    // would turn a solvable "which one?" into a dead end.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hits({ id: 7, title: "Confessions", artist: "Another Artist" })),
    );

    const candidates = await searchSongs("unholy confessions avanged sevenfold");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("explains a missing token rather than failing opaquely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(searchSongs("anything")).rejects.toThrow(/GENIUS_ACCESS_TOKEN/);
  });
});
