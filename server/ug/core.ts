import type { ChordLine, SongIdentity, TabCandidate } from "../../src/ug/types.js";

export class AgentError extends Error {
  // Creates an error with a code that lets the agent distinguish a login requirement from other failures.
  constructor(public code: string, message: string) { super(message); }
}
// Returns an object whose fields can be read safely; missing values, arrays, and other types become an empty object.
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
// Returns the value only if it is a string; otherwise returns an empty string.
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
// Accepts a safe, nonnegative integer. Missing or invalid values become null rather than zero.
export function count(value: unknown): number | null {
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
// Extracts page data from the state embedded by the website.
export function pageData(state: unknown) { return record(record(record(state).store).page).data; }
// Normalizes letter case and separators so song and artist names can be compared consistently.
export function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
// Checks that both the song title and artist match the request after text normalization.
export function sameSong(candidate: TabCandidate, song: SongIdentity) {
  return normalize(candidate.title) === normalize(song.title) && normalize(candidate.artist) === normalize(song.artist);
}
// Resolves relative links and allows only HTTPS URLs on the two approved site domains, without credentials or a nonstandard port.
export function siteUrl(value: string): string {
  let url: URL;
  try { url = new URL(value, "https://www.ultimate-guitar.com"); }
  catch { throw new AgentError("invalid_url", "The source address is not valid."); }
  if (url.protocol !== "https:" || !["www.ultimate-guitar.com", "tabs.ultimate-guitar.com"].includes(url.hostname)
      || url.username || url.password || url.port) {
    throw new AgentError("invalid_url", "The agent can only open Ultimate Guitar pages.");
  }
  return url.href;
}
// Converts a site result into a candidate version. Accepts Official or Chords results and identifies Official versions from their links.
export function tabCandidate(raw: unknown): TabCandidate | null {
  const t = record(raw);
  const official = text(t.type).toLowerCase() === "official" || text(t.marketing_type).toLowerCase() === "official";
  if (!official && (text(t.type) !== "Chords" || t.part === "album")) return null;
  let url: string;
  try { url = siteUrl(text(t.tab_url)); } catch { return null; }
  if (!text(t.tab_url) || !text(t.song_name) || !text(t.artist_name)) return null;
  // Marketing rows use a different tab_id; the link carries the Official ID.
  const linkedId = new URL(url).searchParams.get("tab_id") ?? new URL(url).pathname.match(/-official-(\d+)$/)?.[1];
  const id = official && linkedId ? linkedId : String(t.id ?? t.tab_id ?? "");
  if (!/^\d+$/.test(id)) return null;
  return { id, title: text(t.song_name), artist: text(t.artist_name), url, official,
    version: count(t.version), views: count(t.view_total) };
}
// Reads candidate versions and pagination. Missing structure raises an error rather than implying that no Official version exists.
export function searchPage(state: unknown) {
  const data = record(pageData(state));
  if (!Array.isArray(data.results)) throw new AgentError("site_changed", "The search results could not be read, so this does not show that no official version exists.");
  const pagination = record(data.pagination);
  const total = count(pagination.total);
  const current = count(pagination.current);
  if (total === null || current === null || current < 1) throw new AgentError("site_changed", "The number of search result pages could not be verified.");
  return { candidates: data.results.map(tabCandidate).filter((t): t is TabCandidate => t !== null), total, current };
}
// Prefers a single Official version; otherwise selects by view count. Multiple Official versions, ties, or missing counts require a manual choice.
export function selectCandidate(candidates: TabCandidate[]):
  { selected: TabCandidate; reason: "official" | "most_viewed" } | { choices: TabCandidate[]; message: string } {
  const official = candidates.filter(c => c.official);
  if (official.length === 1) return { selected: official[0]!, reason: "official" };
  if (official.length > 1) return { choices: official, message: "Several official versions were found. Choose the one you want." };
  if (!candidates.length) throw new AgentError("not_found", "No matching chord versions were found on the site.");
  if (candidates.some(c => c.views === null)) return { choices: candidates, message: "View counts are missing for some versions, so the most viewed one can't be determined. Choose a version yourself." };
  const max = Math.max(...candidates.map(c => c.views!));
  const top = candidates.filter(c => c.views === max);
  if (top.length !== 1) return { choices: top, message: "Several versions share the highest view count. Choose one." };
  return { selected: top[0]!, reason: "most_viewed" };
}

// Only explicit source chord tokens are accepted as chords; nothing is inferred. Lyrics are kept as
// text alongside them (the line under a chord line, or words written inline between chords).
// Extracts chords, their positions, the lyrics under them and the song sections, in source order.
export function parseChordContent(content: string) {
  const lines: ChordLine[] = [];
  let section: string | null = null;
  const chart: string[] = [];
  // Text that is only spacing, bar separators, repeat marks or numbers between chords — not words.
  const SPACING = /^[\s|:×x\d()./\-]*$/;
  const spacing = (part: string) => SPACING.test(part) ? part : part.replace(/\S/g, " ");
  // A chord line waits here for the lyric line directly under it.
  let waiting: ChordLine | null = null;
  for (const [index, raw] of content.replace(/\r\n?/g, "\n").split("\n").entries()) {
    const clean = raw.replace(/\[\/?tab\]/gi, "");
    const heading = clean.trim().match(/^\[([^\[\]]+)\]$/);
    if (heading && !/^\/?(?:ch|tab)$/i.test(heading[1]!)) { section = heading[1]!; chart.push(`[${section}]`); waiting = null; continue; }
    const matches = [...clean.matchAll(/\[ch\]([^\[\]\r\n]+)\[\/ch\]/gi)];
    if (!matches.length) {
      const words = clean.trim();
      if (words && waiting) { waiting.lyric = words; chart.push(words); }
      waiting = null;
      continue;
    }
    const chords = matches.map(m => m[1]!.trim());
    if (chords.some(c => !c || c.length > 40)) throw new AgentError("invalid_content", "Invalid chord markings were found.");
    // Rebuild the chord row with each chord at its original column; words between chords become
    // spaces here (they are kept separately as the line's lyric), so alignment survives.
    let cursor = 0;
    let row = "";
    const inline: string[] = [];
    const gap = (part: string) => { if (!SPACING.test(part)) inline.push(part.trim()); return spacing(part); };
    for (const match of matches) {
      row += gap(clean.slice(cursor, match.index)) + match[1];
      cursor = match.index! + match[0].length;
    }
    row += gap(clean.slice(cursor));
    const lyric = inline.join(" ").replace(/\s+/g, " ").trim() || null;
    const entry: ChordLine = { section, sourceLine: index + 1, chords, row: row.trimEnd(), lyric };
    lines.push(entry);
    chart.push(entry.row);
    if (lyric) chart.push(lyric);
    waiting = lyric === null ? entry : null;
  }
  if (!lines.length) throw new AgentError("unsupported_content", "No readable chord markings were found in this version. The agent will not guess chords from tablature or audio.");
  return { lines, uniqueChords: [...new Set(lines.flatMap(l => l.chords))], chart: chart.join("\n") };
}

// Verifies that the page matches the selected version and has no detected access restriction, then returns its data and exact view count.
export function readTab(state: unknown, expected: TabCandidate) {
  const data = record(pageData(state));
  const tab = record(data.tab);
  const actual = tabCandidate(tab);
  const view = record(data.tab_view);
  if (!actual) throw new AgentError("needs_login", "The tab page can't be opened. Finish logging in in the browser, and check that your subscription allows this version.");
  if (actual.id !== expected.id || !sameSong(actual, expected) || actual.official !== expected.official)
    throw new AgentError("source_mismatch", "The page that opened is not the version that was chosen, so extraction stopped.");
  if (view.blocked === true || view.blocked === 1 || view.adsupp_binary_blocked === true)
    throw new AgentError("access_denied", "The site does not allow access to this version's content on the current connection.");
  return { data, tab, view, candidate: { ...actual, views: count(record(view.stats).view_total) } };
}
