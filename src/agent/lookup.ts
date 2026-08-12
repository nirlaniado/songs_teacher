import { lookupSong, type SongFacts } from "./genius.js";

/**
 * Decides whether an instruction is asking for song facts, and fetches them
 * before any provider runs.
 *
 * Asked to "add the song's metadata", a model used to write placeholder text — literally
 * "(song name) metadata" — because that is the shape of an answer without
 * the substance. Resolving facts up front means it either writes real values
 * or reports that it has none.
 *
 * Deliberately *not* an operation: `applyOps` is a pure `Deck -> Deck`
 * transform, and putting a network call inside it would break dry-run
 * preview, validation, and reuse from the MCP server.
 */

/** Words that mean "I want facts about a song", not "write this text". */
const WANTS_FACTS =
  /\b(metadata|meta data|song info|song details|details|artist|album|release(?:d| date| year)?|year|who (?:wrote|sang|made)|credits)\b/i;

/** Explicit lookup language, including the common misspelling from dictation. */
const WANTS_SEARCH = /\b(?:search|serch)(?:\s+the)?\s+(?:web|internet)\s+(?:for|about)\b/i;

/** Verbs that indicate the user wants it *added*, not just asked about. */
const IS_REQUEST =
  /\b(add|set|write|put|fill|insert|f?ind|look ?up|get|fetch|include|create|make|build|generate)\b/i;

/**
 * Verbs that mean the result should become deck edits, not a chat answer.
 *
 * `create`/`make`/`build` matter as much as `add`: "find the metadata … and
 * create a new first slide with it" is unambiguously an edit, and without
 * them it was answered as a lookup and no slide appeared.
 */
const WANTS_EDIT = /\b(add|set|write|put|fill|insert|include|create|make|build|generate|title)\b/i;

/** True when the user wants information returned, rather than deck mutations. */
export function isLookupOnlyRequest(instruction: string): boolean {
  if (WANTS_SEARCH.test(instruction)) return true;
  return WANTS_FACTS.test(instruction) && IS_REQUEST.test(instruction) && !WANTS_EDIT.test(instruction);
}

/**
 * A follow-on instruction tacked onto the request — "… and create a new first
 * slide with it". It says what to do with the facts, not which song to look
 * for, so everything from here on must be cut before searching.
 */
const TRAILING_CLAUSE =
  /\s+(?:and|then|,)\s+(?:also\s+)?(?:create|make|build|generate|add|put|set|write|insert|include|use|place)\b.*$/i;

/** The destination for the facts, likewise not part of the song's name. */
const DESTINATION_CLAUSE =
  /\s+(?:to|on|in|into|onto)\s+(?:the\s+)?(?:new\s+|first\s+|last\s+)*(?:slide|intro|title|verse|chorus|deck)\b.*$/i;

/**
 * Pulls the song name out of an instruction.
 *
 * Handles the shapes people actually type: quoted titles, `for X`, `of X`,
 * `about X`, `X by Y`, and the bare "find me <song> <artist> metadata".
 * Returns null when nothing looks like a title, so we never search Genius for
 * the word "metadata" itself.
 */
export function extractSongQuery(input: string): string | null {
  const text = input.trim().replace(TRAILING_CLAUSE, "");

  const quoted = text.match(/["“']([^"”']{2,80})["”']/);
  if (quoted) {
    const artist = text
      .slice(0, quoted.index)
      .match(/\b(?:for|of|about)\s+(.+?)\s*$/i)?.[1]
      ?.trim();
    return [quoted[1]!.trim(), artist].filter(Boolean).join(" ");
  }

  // "... for|of|about <title> [by <artist>]" — stop at a trailing clause so
  // "for X to the intro" doesn't drag the destination into the query.
  const phrase = text.match(/\b(?:for|of|about)\s+(.+)$/i);
  if (phrase?.[1]) {
    const candidate = phrase[1].replace(DESTINATION_CLAUSE, "").trim().replace(/[.,;]+$/, "");
    if (candidate.length >= 2 && !WANTS_FACTS.test(candidate)) return candidate;
  }

  // "<title> by <artist>" anywhere in the sentence.
  const byArtist = text.match(/([\w'’&().\- ]{2,60}\bby\b[\w'’&().\- ]{2,40})/i);
  if (byArtist?.[1]) return byArtist[1].trim();

  // Last resort: peel the command off the front and the fact-word off the
  // back, and treat whatever survives as the title. This is what catches the
  // most natural phrasing of all — "find me <song> <artist> metadata" — which
  // has no preposition for the branches above to grab onto.
  //
  // Gated on a fact word actually being present: stripping is only meaningful
  // when there's a fact word to strip. Without this the fallback would hand
  // back any old instruction ("create intro verse1 chorus") as a song title.
  if (!WANTS_FACTS.test(text)) return null;

  const stripped = text
    .replace(
      /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:find|get|look\s?up|lookup|fetch|add|set|write|put|fill|insert|include|show)\b/i,
      "",
    )
    .replace(/^\s*(?:me|us)\b/i, "")
    .replace(/^\s*(?:the|a|an)\b/i, "")
    // Trailing destination, so "…to the title slide" isn't searched for.
    .replace(DESTINATION_CLAUSE, "")
    // The fact word itself is what they want, not part of the song's name.
    .replace(
      /\s*\b(?:metadata|meta\s?data|song\s+(?:info|details)|details|info|credits)\b\s*$/i,
      "",
    )
    .trim()
    .replace(/[.,;]+$/, "")
    .trim();

  // Guard against returning a leftover fact word ("find me metadata" -> "").
  if (stripped.length >= 2 && !WANTS_FACTS.test(stripped)) return stripped;

  return null;
}

export interface LookupOutcome {
  /** Facts to hand the provider, when the lookup succeeded. */
  facts?: SongFacts;
  /** A lookup-only request is answered directly instead of becoming an edit plan. */
  answer?: string;
  /**
   * Set when the user clearly wanted facts but we can't supply them. The
   * caller should surface this instead of letting the model invent something.
   */
  blocked?: string;
}

export async function resolveSongFacts(instruction: string): Promise<LookupOutcome> {
  const explicitSearch = WANTS_SEARCH.test(instruction);
  const lookupOnly = isLookupOnlyRequest(instruction);
  if ((!WANTS_FACTS.test(instruction) && !explicitSearch) || (!IS_REQUEST.test(instruction) && !explicitSearch)) {
    return {};
  }

  const query = extractSongQuery(instruction);
  if (!query) {
    // The request was clearly for song facts, so stop here rather than falling
    // through to the providers — an empty plan there surfaces the generic
    // "I don't write lyrics" message, which is the wrong explanation entirely.
    return {
      blocked:
        `I can tell you want song details, but not which song. ` +
        `Try naming it, e.g. \`find metadata for "Song Title" by Artist\`.`,
    };
  }

  try {
    const facts = await lookupSong(query);
    if (!facts) {
      return { blocked: `Genius had no match for "${query}". Type the details and I'll place them.` };
    }
    if (lookupOnly) {
      const details = [facts.artist, facts.album, facts.year].filter(Boolean).join(" · ");
      return {
        answer: `${facts.title}${details ? ` — ${details}` : ""}${facts.url ? `\n${facts.url}` : ""}`,
      };
    }
    return { facts };
  } catch (err) {
    return { blocked: err instanceof Error ? err.message : String(err) };
  }
}
