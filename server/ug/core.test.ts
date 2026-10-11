import { describe, expect, it } from "vitest";
import { parseChordContent, readTab, searchPage, selectCandidate, siteUrl, tabCandidate } from "./core.js";
import type { TabCandidate } from "../../src/ug/types.js";

const candidate = (overrides: Partial<TabCandidate> = {}): TabCandidate => ({ id: "1", title: "Test Song", artist: "Test Artist", url: "https://tabs.ultimate-guitar.com/tab/test/test-chords-1", official: false, version: 1, views: 100, ...overrides });
describe("UG selection from site evidence", () => {
  it("prefers Official even if a community version has more views", () => {
    const official = candidate({ id: "2", official: true, views: null });
    expect(selectCandidate([candidate({ views: 100000 }), official])).toEqual({ selected: official, reason: "official" });
  });
  it("uses views, not result order", () => {
    const popular = candidate({ id: "2", views: 900 });
    expect(selectCandidate([candidate(), popular])).toEqual({ selected: popular, reason: "most_viewed" });
  });
  it("requires a choice when any version has unknown views or the leaders tie", () => {
    expect(selectCandidate([candidate(), candidate({ id: "2", views: null })])).toHaveProperty("choices");
    expect(selectCandidate([candidate(), candidate({ id: "2" })])).toHaveProperty("choices");
  });
  it("uses the Official ID from the marketing link, not the community tab_id", () => {
    const c = tabCandidate({ tab_id: 675652, song_name: "Viva La Vida", artist_name: "Coldplay", marketing_type: "official", tab_url: "https://www.ultimate-guitar.com/pro/?tab_id=1910847" });
    expect(c?.id).toBe("1910847"); expect(c?.official).toBe(true);
    const direct = tabCandidate({ tab_id: 675652, song_name: "Viva La Vida", artist_name: "Coldplay", marketing_type: "official", tab_url: "https://tabs.ultimate-guitar.com/tab/coldplay/viva-la-vida-official-1910847" });
    expect(direct?.id).toBe("1910847");
  });
  it("does not call a Guitar Pro tab or verified community submission Official", () => {
    expect(tabCandidate({ type: "Guitar Pro", verified: 1 })).toBeNull();
    const c = tabCandidate({ id: 1, type: "Chords", verified: 1, song_name: "Test", artist_name: "Artist", tab_url: "https://tabs.ultimate-guitar.com/tab/test-1", votes: 200 });
    expect(c?.official).toBe(false); expect(c?.views).toBeNull();
  });
  it("rejects missing pagination rather than assuming the search is complete", () => {
    expect(() => searchPage({ store: { page: { data: { results: [] } } } })).toThrow();
  });
});
describe("source validation and chord extraction", () => {
  it("preserves chord order, repeats and sections, and keeps the lyric under each chord line", () => {
    const result = parseChordContent("[tab][Intro]\r\n[ch]Am[/ch]  [ch]F[/ch] | [ch]Am[/ch] x2\r\n[Verse 1]\r\n[ch]C/G[/ch]  [ch]Gsus4[/ch]\r\nInvented test lyrics\r\n[/tab]");
    expect(result.lines.map(l => l.chords)).toEqual([["Am", "F", "Am"], ["C/G", "Gsus4"]]);
    expect(result.lines[1]?.section).toBe("Verse 1");
    expect(result.chart).toContain("x2");
    // The lyric belongs to the chord line directly above it, and appears under it in the chart.
    expect(result.lines[0]?.lyric).toBeNull(); expect(result.lines[1]?.lyric).toBe("Invented test lyrics");
    expect(result.chart.split("\n").at(-1)).toBe("Invented test lyrics");
    expect(result.uniqueChords).toEqual(["Am", "F", "C/G", "Gsus4"]);
  });
  it("refuses a page with no explicit chord sequence", () => {
    expect(() => parseChordContent("Available chords: C G Am F")).toThrow();
  });
  it("keeps words written between chords as the line's lyric and keeps the chords aligned", () => {
    const parsed = parseChordContent("[ch]Am[/ch]six 123 words[ch]F[/ch] next phrase");
    expect(parsed.lines[0]?.chords).toEqual(["Am", "F"]);
    // The words become spaces in the chord row (not chords, not digits leaking in)...
    expect(parsed.lines[0]?.row).toMatch(/^Am +F$/);
    // ...and are kept, in order, as the lyric.
    expect(parsed.lines[0]?.lyric).toBe("six 123 words next phrase");
  });
  it("puts each chord at the column it has on the page, over its lyric", () => {
    const parsed = parseChordContent("[ch]G[/ch]        [ch]D[/ch]\nHello darkness my old friend");
    expect(parsed.lines[0]?.row).toBe("G        D");
    expect(parsed.lines[0]?.lyric).toBe("Hello darkness my old friend");
  });
  it("does not attach a lyric across a blank line or a section heading", () => {
    const parsed = parseChordContent("[ch]G[/ch]\n\nOrphan words\n[Chorus]\n[ch]C[/ch]\nSing it");
    expect(parsed.lines.map(l => l.lyric)).toEqual([null, "Sing it"]);
  });
  it("reads exact views from stats and rejects another tab or a paywall", () => {
    const state = { store: { page: { data: { tab: { id: 1, type: "Chords", song_name: "Test Song", artist_name: "Test Artist", tab_url: candidate().url }, tab_view: { stats: { view_total: 1234 } } } } } };
    expect(readTab(state, candidate()).candidate.views).toBe(1234);
    expect(() => readTab(state, candidate({ id: "2" }))).toThrow();
    expect(() => readTab({ store: { page: { data: { has_official_version: true } } } }, candidate({ official: true }))).toThrow();
  });
  it.each(["https://evil.test/", "https://www.ultimate-guitar.com.evil.test/", "http://www.ultimate-guitar.com/", "https://user:pass@www.ultimate-guitar.com/", "https://www.ultimate-guitar.com:444/"])("rejects an off-site or credential-bearing URL: %s", url => {
    expect(() => siteUrl(url)).toThrow();
  });
});
