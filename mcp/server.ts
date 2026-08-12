import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatCue } from "../src/schema/deck.js";
import { applyOps, validateOps } from "../src/agent/apply.js";
import { describeOps } from "../src/agent/describe.js";
import { Op, type Target } from "../src/agent/ops.js";
import { LAYOUTS, THEME_PRESETS } from "../src/deck/templates.js";
import { DeckLibrary, resolveLibraryRoot } from "./library.js";
import { fetchCoverArt, getSong, searchSongs } from "./genius.js";

/**
 * MCP server for libre-off presentations.
 *
 * Lets Claude Code, Codex or any MCP client build decks from the CLI against
 * the same library folder the editor uses.
 *
 * The design point: this exposes the *same* `Op` vocabulary the in-app
 * assistant uses, applied through the *same* pure `applyOps` transform and
 * validated by the *same* `Deck` schema. It is a third producer of one
 * contract, not a parallel implementation — so a deck built here is
 * indistinguishable from one built by hand, and no capability can drift
 * between the CLI and the app.
 *
 * Everything mutating goes through `validateOps` first, so a bad plan is
 * reported rather than written. There is no undo on disk.
 */

const library = new DeckLibrary(resolveLibraryRoot(process.argv));
const server = new McpServer({ name: "libre-off", version: "0.1.0" });

/** MCP tools return content blocks; these keep the call sites readable. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}
function fail(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

// ── reading ────────────────────────────────────────────────────────────────

server.registerTool(
  "list_decks",
  {
    title: "List presentations",
    description:
      "List every presentation in the libre-off library, with slide counts and whether each has an audio track.",
    inputSchema: {},
  },
  async () => {
    const decks = await library.list();
    if (decks.length === 0) return text("The library has no presentations yet.");
    return text(
      decks
        .map(
          (d) =>
            `${d.id}  "${d.title}"  ${d.slideCount} slide${d.slideCount === 1 ? "" : "s"}` +
            `${d.hasAudio ? "  [has audio]" : ""}  updated ${d.updatedAt}`,
        )
        .join("\n"),
    );
  },
);

server.registerTool(
  "read_deck",
  {
    title: "Read a presentation",
    description:
      "Full structure of one presentation: every slide's index, name, layout, cue time and text. Read this before applying operations so targets resolve correctly.",
    inputSchema: { deckId: z.string().describe("Deck id from list_decks") },
  },
  async ({ deckId }) => {
    try {
      const deck = await library.read(deckId);
      const lines = [
        `"${deck.title}" — ${deck.slides.length} slide(s), theme ${deck.theme.preset}`,
        deck.audio ? `audio: ${deck.audio.path}` : "audio: none",
        "",
      ];
      for (const [i, slide] of deck.slides.entries()) {
        const cue = slide.startTime === undefined ? "no cue" : `cue ${formatCue(slide.startTime)}`;
        lines.push(`[${i}] "${slide.name}"  ${slide.layout}  ${cue}`);
        for (const el of slide.elements) {
          if (el.kind === "text" && el.text.trim() !== "") {
            lines.push(`      ${el.role}: ${el.text.replace(/\n/g, " / ")}`);
          }
        }
      }
      return text(lines.join("\n"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "describe_capabilities",
  {
    title: "Describe editor capabilities",
    description:
      "The layouts, themes and targeting forms available when writing operations. Call this if unsure what values apply_ops accepts.",
    inputSchema: {},
  },
  async () =>
    text(
      [
        `LAYOUTS: ${LAYOUTS.map((l) => `${l.id} (${l.label})`).join(", ")}`,
        `THEMES: ${THEME_PRESETS.map((t) => `${t.preset} (${t.label})`).join(", ")}`,
        "",
        "TARGET forms (every slide-editing op takes one):",
        '  {"by":"index","indexes":[0,2]}                     0-based positions',
        '  {"by":"family","base":"Chorus"}                    all slides in a section family',
        '  {"by":"nameOrdinal","base":"Verse","ordinals":[1,2,3]}  1st/2nd/3rd verse in order',
        '  {"by":"name","pattern":"outro"}                    name CONTAINS this text',
        '  {"by":"all"}  |  {"by":"current"}',
        "",
        'Prefer "family"/"nameOrdinal" for section names — "name" matches substrings,',
        'so it would also hit "Pre-Chorus" when you meant "Chorus".',
        "",
        "Cue times must increase down the deck; a backwards cue is rejected.",
        "Text is placed verbatim — never infer chords, keys or lyrics.",
      ].join("\n"),
    ),
);

// ── writing ────────────────────────────────────────────────────────────────

server.registerTool(
  "create_deck",
  {
    title: "Create a presentation",
    description: "Create an empty presentation and return its id.",
    inputSchema: { title: z.string().min(1).describe("Title of the new presentation") },
  },
  async ({ title }) => {
    const deck = await library.create(title);
    return text(`Created "${deck.title}" with id ${deck.id}. It has no slides yet.`);
  },
);

server.registerTool(
  "apply_ops",
  {
    title: "Edit a presentation",
    description:
      "Apply a batch of editor operations to a presentation: create/rename/reorder/delete slides, set titles and body text, set layouts, set cue times, and change design. Ops apply in order, each seeing the previous one's result. Set dryRun to preview without writing.",
    inputSchema: {
      deckId: z.string().describe("Deck id from list_decks"),
      ops: z.array(Op).min(1).describe("Operations to apply, in order"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Report what would happen without saving. Defaults to false."),
    },
  },
  async ({ deckId, ops, dryRun }) => {
    if (dryRun) {
      try {
        const deck = await library.read(deckId);
        const check = validateOps(deck, ops);
        if (!check.ok) return fail(`Would fail — ${check.error}`);
        return text(
          `Would apply:\n${describeOps(deck, ops)
            .map((l) => `• ${l.text}${l.empty ? "  (matches nothing)" : ""}`)
            .join("\n")}`,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    // Read-modify-write goes through `mutate` so concurrent tool calls are
    // serialized per deck. Without it two overlapping edits lose one of the
    // updates and can leave the file itself corrupt.
    let plan = "";
    try {
      const saved = await library.mutate(deckId, (deck) => {
        // Validated inside the lock, against the deck as it actually is now —
        // checking beforehand would test a snapshot that may already be stale.
        const check = validateOps(deck, ops);
        if (!check.ok) throw new Error(`Not applied — ${check.error}`);
        plan = describeOps(deck, ops)
          .map((l) => `• ${l.text}${l.empty ? "  (matches nothing)" : ""}`)
          .join("\n");
        return applyOps(deck, ops).deck;
      });
      return text(
        `Applied to "${saved.title}" (${saved.slides.length} slides now):\n${plan}\n\n` +
          `Saved. Reload the deck in the editor to see it.`,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// ── Genius metadata ────────────────────────────────────────────────────────
// Metadata only. The Genius API has no lyrics endpoint — see mcp/genius.ts.

server.registerTool(
  "genius_search",
  {
    title: "Find a song on Genius",
    description:
      "Search Genius for a song and return candidates with their ids, artists and release dates. METADATA ONLY — Genius has no lyrics endpoint, so this cannot return lyrics. Use the id with genius_title_slide.",
    inputSchema: {
      query: z.string().min(1).describe('Song and artist, e.g. "Until The End Avenged Sevenfold"'),
    },
  },
  async ({ query }) => {
    try {
      const hits = await searchSongs(query);
      if (hits.length === 0) return text(`Nothing on Genius for "${query}".`);
      return text(
        hits
          .map(
            (h) =>
              `${h.id}  "${h.title}" — ${h.artist}` +
              `${h.releasedDisplay ? `  (${h.releasedDisplay})` : ""}` +
              `${h.artUrl ? "  [has cover art]" : ""}`,
          )
          .join("\n"),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "genius_title_slide",
  {
    title: "Build a title slide from Genius metadata",
    description:
      "Create a title slide for a song using Genius metadata: title, artist, album, release year, and cover art downloaded into the deck. Adds a new slide at the front unless replaceSlide is given. Does NOT add lyrics — Genius provides no lyrics endpoint.",
    inputSchema: {
      deckId: z.string().describe("Deck id from list_decks"),
      songId: z.number().int().describe("Genius song id from genius_search"),
      includeCover: z
        .boolean()
        .optional()
        .describe("Download and place the cover art. Defaults to true."),
      replaceSlide: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Index of an existing slide to fill instead of creating a new one."),
    },
  },
  async ({ deckId, songId, includeCover, replaceSlide }) => {
    try {
      const song = await getSong(songId);
      const year = song.releaseDate?.slice(0, 4) ?? song.releasedDisplay ?? "";
      const subtitleParts = [song.artist, song.album, year].filter(
        (part): part is string => typeof part === "string" && part.trim() !== "",
      );

      // Cover art is downloaded before the edit so the op only ever
      // references a file that already exists in the deck.
      let coverPath: string | null = null;
      if (includeCover !== false) {
        const art = await fetchCoverArt(song.artUrl);
        if (art) {
          coverPath = await library.writeAsset(deckId, `cover-${songId}.${art.ext}`, art.data);
        }
      }

      const ops: Op[] = [];
      if (replaceSlide === undefined) {
        ops.push({
          op: "createSlides",
          slides: [
            {
              name: song.title,
              title: song.title,
              layout: "centered",
              body: subtitleParts.join(" · "),
            },
          ],
          at: 0,
        });
      } else {
        const at: Target = { by: "index", indexes: [replaceSlide] };
        ops.push({ op: "setLayout", target: at, layout: "centered" });
        ops.push({ op: "setTitle", target: at, text: song.title });
        ops.push({ op: "setBody", target: at, text: subtitleParts.join(" · ") });
        ops.push({ op: "renameSlide", target: at, name: song.title });
      }
      if (coverPath) {
        ops.push({
          op: "addImage",
          target: { by: "index", indexes: [replaceSlide ?? 0] },
          src: coverPath,
        });
      }

      let plan = "";
      const saved = await library.mutate(deckId, (deck) => {
        const check = validateOps(deck, ops);
        if (!check.ok) throw new Error(`Not applied — ${check.error}`);
        plan = describeOps(deck, ops)
          .map((l) => `• ${l.text}`)
          .join("\n");
        return applyOps(deck, ops).deck;
      });

      return text(
        `Built a title slide in "${saved.title}" from Genius:\n${plan}\n\n` +
          `Source: ${song.url}\n` +
          `Metadata only — Genius provides no lyrics. Paste lyrics you hold rights to using ` +
          `[Section] blocks in the app's assistant.`,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "delete_deck",
  {
    title: "Delete a presentation",
    description:
      "Permanently delete a presentation and its assets. There is no undo — confirm with the user first.",
    inputSchema: { deckId: z.string().describe("Deck id from list_decks") },
  },
  async ({ deckId }) => {
    try {
      const deck = await library.read(deckId);
      await library.remove(deckId);
      return text(`Deleted "${deck.title}".`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// stdout is the JSON-RPC channel — anything printed there corrupts the
// protocol, so diagnostics must go to stderr.
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[libre-off] MCP server ready (library: ${resolveLibraryRoot(process.argv)})`);
