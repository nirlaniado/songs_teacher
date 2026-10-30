import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError, parseChordContent, readTab, searchPage, selectCandidate, siteUrl } from "./core.js";
import type { TabCandidate } from "../../src/ug/types.js";

const root = new URL("../../", import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), "utf8");
const files = ["src", "server"].flatMap(dir => (readdirSync(join(root, dir), { recursive: true }) as string[])
  .map(file => join(dir, file))
  .filter(file => statSync(join(root, file)).isFile()));
// Binary means "does not decode", not "contains a NUL": src/theory/rotation.test.ts has literal NULs and is ordinary source.
const decoded = (file: string) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(root, file))); } catch { return null; }
};
const textFiles = files.flatMap(file => { const text = decoded(file); return text === null ? [] : [{ file, text }]; });
const skipped = files.filter(file => decoded(file) === null);
const BINARY_FORMAT = /\.(png|jpe?g|gif|webp|ico|mp3|wav|onnx|wasm|woff2?|zip)$/i;

const candidate = (over: Partial<TabCandidate> = {}): TabCandidate => ({ id: "1", url: "https://tabs.ultimate-guitar.com/tab/a/b-chords-1", title: "Song", artist: "Artist", version: 1, views: 10, official: false, ...over });
const message = (fn: () => unknown) => {
  try { fn(); } catch (error) { if (error instanceof AgentError) return error.message; throw error; }
  throw new Error("expected an AgentError");
};

describe("the chord agent speaks one language", () => {
  it("scans every file under src and server, skipping only known binary formats", () => {
    expect(textFiles.map(f => f.file)).toEqual(expect.arrayContaining([
      join("src", "index.css"), join("src", "example", "song.example.json"), join("src", "theory", "rotation.test.ts"),
      join("src", "components", "deck", "__snapshots__", "SlideRenderer.test.ts.snap"), join("server", "ug", "messages.test.ts"),
    ]));
    // A text file in another encoding fails to decode too, so a skip has to be a recognised format or it could hide anything.
    expect(skipped.filter(file => !BINARY_FORMAT.test(file))).toEqual([]);
  });

  it("finds no Hebrew in any of those files", () => {
    for (const { file, text } of textFiles) expect(text, file).not.toMatch(/[\u0590-\u05FF]/);
  });

  it("does not force a direction or a date locale on the screen", () => {
    const screen = read("src/components/UltimateGuitarAgent.tsx");
    expect(screen).not.toMatch(/dir="(rtl|ltr)"/);
    expect(screen).not.toMatch(/toLocaleString\("/);
  });

  // These hold what the user typed or the site returned, so a Hebrew or Arabic title stays legitimate whatever the UI's language.
  it("keeps dir=auto on the input and on both kinds of site-supplied heading", () => {
    const screen = read("src/components/UltimateGuitarAgent.tsx");
    expect(screen).toMatch(/<Field dir="auto"/);
    expect(screen).toMatch(/<h2 dir="auto"[^>]*>\{job\.identity\.title\}/);
    expect(screen).toMatch(/dir="auto"[^>]*>\{c\.title\}/);
  });

  it("names the old command alias in none of those files, and both of the screen's fetch failures say npm start", () => {
    const alias = ["dev", "agent"].join(":");
    for (const { file, text } of textFiles) expect(text, file).not.toContain(alias);
    expect(read("src/components/UltimateGuitarAgent.tsx").match(/Run npm start\./g)).toHaveLength(2);
  });
});

// The value of these messages is what they say the agent refused to do, so that wording is pinned rather than just the error code.
describe("messages keep what the agent did not do", () => {
  it("does not let unreadable search results read as no official version", () => {
    expect(message(() => searchPage({ store: { page: { data: {} } } }))).toContain("does not show that no official version exists");
  });

  it("refuses to guess chords", () => {
    expect(message(() => parseChordContent("Available chords: C G Am F"))).toContain("will not guess chords");
  });

  it.each([
    ["its link could not be identified", "No user version was chosen."],
    ["its chord view did not load", "No user version was chosen in its place."],
    ["no chord text that can be extracted", "It was not replaced with an unofficial version."],
  ])("states no substitution when %s", (what, refusal) => {
    const line = read("server/ug/browser.ts").split("\n").find(l => l.includes(what));
    expect(line).toContain(refusal);
  });

  it("never implies a failed service returned estimated chords", () => {
    expect(read("server/ug/agent.ts")).toContain("No guessed chords were returned.");
  });
});

describe("messages say what to do next", () => {
  it("asks for a choice when view counts cannot decide", () => {
    expect(selectCandidate([candidate({ views: null })])).toMatchObject({ message: expect.stringContaining("Choose a version yourself") });
    expect(selectCandidate([candidate(), candidate({ id: "2" })])).toMatchObject({ message: expect.stringContaining("share the highest view count") });
  });

  it("refuses a page that is not the chosen version", () => {
    const state = { store: { page: { data: { tab: { id: 1, type: "Chords", song_name: "Song", artist_name: "Artist", tab_url: candidate().url }, tab_view: { stats: { view_total: 1 } } } } } };
    expect(message(() => readTab(state, candidate({ id: "2" })))).toContain("extraction stopped");
  });

  it("explains an unreachable tab page in terms of login and subscription", () => {
    expect(message(() => readTab({ store: { page: { data: {} } } }, candidate()))).toContain("check that your subscription");
  });

  it("names what the agent may open", () => {
    expect(message(() => siteUrl("https://evil.test/"))).toBe("The agent can only open Ultimate Guitar pages.");
    expect(message(() => siteUrl("https://"))).toBe("The source address is not valid.");
  });
});
