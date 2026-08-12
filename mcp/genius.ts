/**
 * Genius API client — **metadata only**.
 *
 * The Genius API returns song title, artist, album, release date and cover
 * art. It does NOT return lyrics: Genius licenses lyric text from publishers
 * and has no redistribution rights, so no lyrics endpoint exists. Libraries
 * that appear to fetch lyrics from Genius use the API only to locate a song's
 * page and then scrape the HTML — which is outside the API and against their
 * terms.
 *
 * Do not add scraping here. If lyrics are ever needed, the routes are a
 * licensed provider (Musixmatch, LyricFind) or text the user supplies, which
 * the assistant's `[Section]` paste flow already handles.
 */

const API = "https://api.genius.com";

export interface SongHit {
  id: number;
  title: string;
  artist: string;
  /** e.g. "Oct. 27, 2005" — Genius's own display string, may be absent. */
  releasedDisplay?: string;
  artUrl?: string;
  url: string;
}

export interface SongDetail extends SongHit {
  album?: string;
  /** ISO-ish "YYYY-MM-DD" when Genius has it. */
  releaseDate?: string;
}

export function geniusToken(): string {
  const token = process.env.GENIUS_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GENIUS_ACCESS_TOKEN is not set. Create a free API client at " +
        "https://genius.com/api-clients, copy its Client Access Token, and put it in .env.",
    );
  }
  return token;
}

async function call(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${geniusToken()}` },
  });
  if (response.status === 401) {
    throw new Error("Genius rejected the token (401). Check GENIUS_ACCESS_TOKEN in .env.");
  }
  if (!response.ok) {
    throw new Error(`Genius returned ${response.status} for ${path}`);
  }
  const body = (await response.json()) as { response?: Record<string, unknown> };
  if (!body.response) throw new Error("Unexpected response shape from Genius");
  return body.response;
}

function toHit(result: Record<string, any>): SongHit {
  return {
    id: Number(result.id),
    title: String(result.title ?? "Unknown title"),
    artist: String(result.primary_artist?.name ?? "Unknown artist"),
    releasedDisplay: result.release_date_for_display ?? undefined,
    artUrl: result.song_art_image_url ?? result.header_image_url ?? undefined,
    url: String(result.url ?? ""),
  };
}

export async function searchSongs(query: string, limit = 8): Promise<SongHit[]> {
  const response = await call(`/search?q=${encodeURIComponent(query)}`);
  const hits = (response.hits as Array<Record<string, any>>) ?? [];
  return hits
    .filter((h) => h.type === "song" && h.result)
    .slice(0, limit)
    .map((h) => toHit(h.result));
}

export async function getSong(id: number): Promise<SongDetail> {
  const response = await call(`/songs/${id}`);
  const song = response.song as Record<string, any>;
  if (!song) throw new Error(`No song ${id} on Genius`);
  return {
    ...toHit(song),
    album: song.album?.name ?? undefined,
    releaseDate: song.release_date ?? undefined,
  };
}

/**
 * Downloads cover art. Returns the bytes plus a file extension guessed from
 * the content type, or null when there's no art or it can't be fetched —
 * a missing cover should degrade to a text-only title slide, not fail the
 * whole operation.
 */
export async function fetchCoverArt(
  url: string | undefined,
): Promise<{ data: Uint8Array; ext: string } | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    return { data: new Uint8Array(await response.arrayBuffer()), ext };
  } catch {
    return null;
  }
}
