/**
 * Browser-side Genius lookup — **metadata only**.
 *
 * Exists because the assistant was writing placeholder text like
 * "(song name) metadata" onto slides: asked for song details, it had no facts
 * and no way to get any, so it wrote something shaped like an answer. Giving
 * it real values fixes the cause rather than the symptom.
 *
 * Genius returns title, artist, album, release date and cover art. It has no
 * lyrics endpoint — Genius licenses lyric text from publishers and has no
 * redistribution rights, so lyric text is outside this metadata client.
 */

/**
 * Same-origin, proxied to `api.genius.com` by the dev server (see
 * `vite.config.ts`).
 *
 * Not called directly: the required `Authorization` header makes the request
 * non-simple, so the browser preflights with OPTIONS and Genius answers 403 —
 * surfacing as a bare "Failed to fetch". The proxy also injects the token
 * server-side, so it never reaches the bundle.
 */
const API = "/api/genius";

export interface SongFacts {
  title: string;
  artist: string;
  album?: string;
  year?: string;
  url: string;
}

/**
 * Always true in the browser: the token lives on the proxy, so the page has
 * no way to know whether one is configured until a request comes back 401.
 * Kept so callers read clearly, and so a future build with no proxy can say
 * so honestly rather than guessing.
 */
export function isGeniusConfigured(): boolean {
  return true;
}

/**
 * Words people append that describe the *request*, not the record. Genius
 * matches literally enough that one of these can be the difference between
 * the right song and nothing at all: "avanged sevenfokd untill the end"
 * finds the track despite two misspellings, while the same query plus the
 * word "song" returns zero hits.
 */
const QUERY_NOISE = /\s+\b(?:song|track|tune|single|the\s+song|by)\b\s*$/gi;

export function cleanQuery(query: string): string {
  let cleaned = query.trim();
  for (let i = 0; i < 3; i++) cleaned = cleaned.replace(QUERY_NOISE, "").trim();
  return cleaned || query.trim();
}

/**
 * Minimum share of the query a hit must account for.
 *
 * Under half means Genius reached for something unrelated — the failure mode
 * that put a stranger's music-collection page onto a title slide.
 */
export const MIN_CONFIDENCE = 0.5;

/** Comparable word set, for judging whether a hit relates to the query at all. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

/**
 * How much of the query the hit actually accounts for, 0..1.
 *
 * Deliberately lenient on spelling — a token counts if it matches a hit token
 * by prefix in either direction, so "avanged" still scores against "avenged"
 * and typos don't reject a correct result.
 */
export function overlap(query: string, hit: string): number {
  const wanted = tokens(query);
  if (wanted.length === 0) return 1;
  const have = tokens(hit);
  const matched = wanted.filter((w) =>
    have.some((h) => h === w || (w.length >= 4 && (h.startsWith(w.slice(0, 4)) || w.startsWith(h.slice(0, 4))))),
  );
  return matched.length / wanted.length;
}

export interface SongCandidate extends SongFacts {
  /** Genius's song id, so the album can be fetched if this one is chosen. */
  id: number;
  /** How much of the query this hit accounts for, 0..1. */
  confidence: number;
}

/**
 * The album, which the search payload omits.
 *
 * Fetched only for the candidate actually chosen — one request instead of one
 * per hit — and tolerated as missing, so a slow or failed second call can't
 * lose the facts already in hand.
 */
export async function withAlbum(candidate: SongCandidate): Promise<SongFacts> {
  const { id, confidence, ...facts } = candidate;
  try {
    const detail = await fetch(`${API}/songs/${id}`);
    if (!detail.ok) return facts;
    const song = ((await detail.json()) as { response?: { song?: Record<string, any> } })
      .response?.song;
    const album = song?.album?.name;
    return album ? { ...facts, album: String(album) } : facts;
  } catch {
    return facts;
  }
}

/**
 * Ranked candidates for a query, best first, with anything clearly unrelated
 * dropped.
 *
 * Returning several rather than one is what lets a caller *ask* when the
 * answer is uncertain. Silently taking `hits[0]` is how a stranger's
 * music-collection page ended up on a title slide: Genius indexes those and
 * types them as songs, so a poor query can rank one top.
 */
export async function searchSongs(query: string, limit = 5): Promise<SongCandidate[]> {
  const cleaned = cleanQuery(query);
  const search = await fetch(`${API}/search?q=${encodeURIComponent(cleaned)}`);
  if (!search.ok) {
    throw new Error(
      search.status === 401
        ? "Genius rejected the request. Set GENIUS_ACCESS_TOKEN in .env and restart the dev server."
        : `Genius search failed (${search.status}).`,
    );
  }

  const body = (await search.json()) as {
    response?: { hits?: Array<{ type?: string; result?: Record<string, any> }> };
  };

  return (body.response?.hits ?? [])
    .filter((h) => h.type === "song" && h.result)
    .map((h, index) => ({ result: h.result!, index }))
    .map(({ result, index }) => ({
      index,
      confidence: overlap(cleaned, `${result.title ?? ""} ${result.primary_artist?.name ?? ""}`),
      facts: {
        id: Number(result.id ?? 0),
        title: String(result.title ?? cleaned),
        artist: String(result.primary_artist?.name ?? "Unknown artist"),
        year:
          (result.release_date as string | undefined)?.slice(0, 4) ??
          (result.release_date_for_display as string | undefined)?.match(/\d{4}/)?.[0],
        url: String(result.url ?? ""),
      },
    }))
    // A quarter is well below the accept threshold but still worth showing:
    // when nothing is confident, these become the options offered to the user.
    .filter((c) => c.confidence >= 0.25)
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
    .slice(0, limit)
    .map(({ facts, confidence }) => ({ ...facts, confidence }));
}

/**
 * Best match for a free-text query, or null when nothing matches confidently.
 *
 * Hits are *scored*, not taken blindly. Returning null instead of a poor match
 * lets the caller say it found nothing, which is far better than confident
 * nonsense on a slide.
 */
export async function lookupSong(query: string): Promise<SongFacts | null> {
  const cleaned = cleanQuery(query);
  const search = await fetch(`${API}/search?q=${encodeURIComponent(cleaned)}`);
  if (!search.ok) {
    throw new Error(
      search.status === 401
        ? "Genius rejected the request. Set GENIUS_ACCESS_TOKEN in .env and restart the dev server."
        : `Genius search failed (${search.status}).`,
    );
  }

  const body = (await search.json()) as {
    response?: { hits?: Array<{ type?: string; result?: Record<string, any> }> };
  };
  const candidates = (body.response?.hits ?? [])
    .filter((h) => h.type === "song" && h.result)
    .map((h) => h.result!);

  // Ranked by how much of the query the title and artist together explain,
  // with Genius's own ordering as the tiebreak.
  const scored = candidates
    .map((result, index) => ({
      result,
      index,
      score: overlap(cleaned, `${result.title ?? ""} ${result.primary_artist?.name ?? ""}`),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const best = scored[0];
  if (!best || best.score < MIN_CONFIDENCE) return null;
  const hit = best.result;

  // The search payload carries everything except the album, which needs the
  // song endpoint. Fetched separately, and tolerated as missing on failure so
  // a slow second call can't lose the facts we already have.
  let album: string | undefined;
  try {
    const detail = await fetch(`${API}/songs/${hit.id}`);
    if (detail.ok) {
      const song = ((await detail.json()) as { response?: { song?: Record<string, any> } })
        .response?.song;
      album = song?.album?.name ?? undefined;
    }
  } catch {
    // Album is a nice-to-have; the rest of the facts stand without it.
  }

  const releaseDate: string | undefined = hit.release_date ?? undefined;
  const displayed: string | undefined = hit.release_date_for_display ?? undefined;

  return {
    title: String(hit.title ?? query),
    artist: String(hit.primary_artist?.name ?? "Unknown artist"),
    album,
    // Prefer the ISO date's year; fall back to whatever Genius displays.
    year: releaseDate?.slice(0, 4) ?? displayed?.match(/\d{4}/)?.[0],
    url: String(hit.url ?? ""),
  };
}

/** One line per fact, for injecting into the model's prompt. */
export function factsBlock(facts: SongFacts): string {
  return [
    `title: ${facts.title}`,
    `artist: ${facts.artist}`,
    facts.album ? `album: ${facts.album}` : null,
    facts.year ? `year: ${facts.year}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** The subtitle line a title slide usually wants. */
export function factsSummary(facts: SongFacts): string {
  return [facts.artist, facts.album, facts.year].filter(Boolean).join(" · ");
}
