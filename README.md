# libre-off

**A presentation editor whose slides follow the music.** Build a deck the way you would in
LibreOffice Impress, attach a song, and cue each slide to a timestamp — intro slide at
0:00, first verse at 1:20, chorus at 2:22. Press Present and the track plays while the
deck advances itself, so a music teacher can talk over a "song presentation" instead of
clicking through it.

Also included, from the project's earlier life: a song-study mode for marking sections of
a track and writing harmonic analysis, plus a graph that links songs by shared chord
progressions. It still works and is reachable from the start screen.

Musical analysis is authored by hand — nothing here detects chords or infers keys. Audio
is only ever played, never acquired: songs are local files you already have, never
downloaded, ripped, or transcoded from a streaming service.

Runs via Vite in every major browser (Chrome, Edge, Brave, Firefox, Safari).

```
src/
├── schema/
│   ├── deck.ts       ★ the primary document: Deck, Slide, SlideElement
│   │                   (text | image | shape | tab), Theme, cue helpers.
│   │                   Fixed 1280x720 coordinate space.
│   ├── song.ts       song-study document: Song, Section, KeyRef, AudioRef
│   └── blocks.ts     song-study slide blocks
├── deck/
│   ├── templates.ts  layouts (placeholder generators) + theme presets
│   ├── geometry.ts   ★ editing math: snapping, marquee enclosure, bounds, align —
│   │                   pure and unit-tested, in slide units only
│   └── bundle.ts     .zip export/import of a deck and its media
├── adapters/         the only place the platform is allowed to leak in
│   ├── types.ts       LibraryAdapter — implement once per platform
│   ├── paths.ts        assertRelativeSegments() — shared path-escape guard
│   ├── browser.ts      File System Access API — real folder, Chromium only
│   ├── indexeddb.ts    fallback for Firefox/Safari — browser storage, no real folder
│   └── index.ts        sharedLibraryAdapter() — one instance for the whole app
├── store/            Zustand state, kept out of React's render tree
│   ├── deckStore.ts    ★ the editor: deck/slide/element mutations + undo/redo
│   ├── agentStore.ts   assistant transcript + pending plan (never edits directly)
│   ├── playerStore.ts  song-study playback clock, ticked by rAF
│   ├── libraryStore.ts song-study library
│   └── graphStore.ts   builds the harmonic graph on demand
├── agent/            the assistant — one op vocabulary, several producers
│   ├── ops.ts          ★ THE CONTRACT: Op + Target unions (Zod)
│   ├── targets.ts      resolveTarget() — which slides an op acts on
│   ├── apply.ts        applyOps() pure batch transform + validateOps() dry run
│   ├── describe.ts     Op -> the sentence shown in the preview
│   ├── prompt.ts       system prompt + JSON Schema for model providers
│   ├── parse/          sections.ts (vocabulary) + grammar.ts (the parser)
│   └── providers/      deterministic (default) · openaiCompatible (any
│                       OpenAI-style endpoint, reads .env) · codexCli (desktop)
├── components/
│   ├── DeckLibraryScreen.tsx   start screen
│   ├── DeckScreen.tsx          the editor window + Focus mode (full-screen editing)
│   ├── deck/                   SlideRenderer, SlideCanvas (multi-select, snapping,
│   │                           marquee, rotate), CanvasContextMenu, SlidePanel,
│   │                           EditorToolbar, PropertiesPanel, TimingPanel,
│   │                           PresentMode, AgentPanel, StemMixer, SeparateStems,
│   │                           useDeckAssets, useFullscreen
│   └── …                       song-study screens (Waveform, SongScreen, …)
├── audio/            playback + separation
│   ├── mix.ts          ★ pure solo/mute → per-stem gain (solo beats mute)
│   ├── types.ts        DeckPlayer interface
│   ├── elementPlayer.ts  <audio> — decks with no stems
│   ├── stemPlayer.ts   ★ Web Audio mixer, sample-accurate multi-track
│   ├── useDeckPlayer.ts  picks the engine; owns the rAF clock ONCE
│   └── separate.ts     Demucs ONNX + model cache + WAV encoder
├── theory/           pure functions over `tonal` — roman numerals, canonical
│                     rotation (Booth's algorithm), n-grams
├── graph/            harmonic index — pure, rebuilt on demand, nothing persisted
└── example/
    └── song.example.json

mcp/                  Node-only MCP server — build decks from the CLI
├── library.ts        fs deck I/O: atomic writes + per-deck write serialization
└── server.ts         stdio server; apply_ops takes the same Op vocabulary
```

```bash
npm install
npm run dev        # vite dev server
npm test           # 328 tests
npm run typecheck
npm run build      # typecheck + production build
npm run mcp:build  # compile the MCP server (see "From the CLI, via MCP")
```

## Making a song presentation

1. Open a folder to keep your work in (Chrome/Edge/Brave store real files; Firefox and
   Safari fall back to browser storage).
2. Create a presentation. You get a title slide to start from.
3. Build slides — pick a layout from the right rail, double-click text to edit it, insert
   images and shapes from the toolbar, drag and resize on the canvas. See "Editing on the
   canvas" below for the full command set — multi-select, align, snapping, and more.
4. Set a backdrop. In the right rail, **Master / theme → Background (all slides)** applies
   to the whole deck; the **Slide → Background** control overrides just the current one.
   Either can be a flat color or a saved image — upload one, or reuse an image already in
   the deck. Image backdrops get a fit mode (cover / contain / stretch / tile) and a *Dim*
   slider that darkens the photo so text on top stays readable.
5. In the **Music sync** panel at the bottom, add an MP3.
6. Play the track. When it reaches the moment a slide should appear, press **Set** on that
   slide's row. Or type a time directly as `1:20`.
7. Press **Present**. The song plays and the deck follows its cues. Arrow keys override
   auto-advance; the "Following music" button hands control back.

Cue times must run forward through the deck — the panel flags it inline if they don't,
since a backwards cue would make the deck jump backwards mid-song.

## Editing on the canvas

The editor mirrors Impress's interaction design — same commands, same shortcuts, same
rules for what "align" and "distribute" mean — even though nothing here is built on
Impress's code.

| Gesture | Does |
|---|---|
| Click / Shift+click / Ctrl+click | Select · extend the selection |
| Drag on empty space | Rubber-band select — must fully enclose an element to pick it |
| Drag an element | Move it, or the whole selection together |
| Drag a handle | Resize (single selection only) |
| Drag the round handle above the selection | Rotate; hold Shift for 15° steps |
| Hold Alt while dragging | Suspend snapping for that drag |
| Arrow keys / Shift+arrow | Nudge by 2 units / one grid step |
| Ctrl+A / C / X / V / D | Select all / copy / cut / paste / duplicate |
| Ctrl+Shift+↑ ↓ Home End | Bring forward / send backward / to front / to back |
| Right-click | Full command menu, scoped to what's under the pointer |
| Del / Backspace | Delete the selection — locked elements are spared |

The toolbar also carries align (left/center/right/top/middle/bottom — several elements
align to each other, a lone one centers on the slide), distribute (needs three or more —
two elements are just the endpoints), a grid toggle, and zoom. Selecting more than one
element switches the right rail to a group panel with the same commands.

Shrinking a text or tab box below what its content needs shrinks the font to fit, rather
than cropping it — the stored font size isn't touched, so growing the box back out returns
it to full size. The box you're actively typing into behaves differently on purpose: it
grows to show everything you're writing at true size instead, reverting to its saved size
the moment you click away. That growth is capped at the edge of the slide itself — a box
positioned low or wide on the slide can only grow so far before it would run off the
slide's own edge — and past that cap it scrolls internally, like any text box, so nothing
you've typed is ever unreachable.

**Focus mode** (the `⛶ Focus` button, or Ctrl+Shift+F) goes full-screen with the app chrome
and the music panel dropped, for building slides when timing isn't the job — useful on a
small screen or just to get the canvas as large as possible. The slide rail, properties
panel and assistant each have their own toggle inside focus mode, so you can strip down to
canvas-only. Exit with the button or Esc; the music panel comes back the way you left it.

### Tabs

**+ Tab ▾** on the toolbar opens a tuning picker — Standard, Half step down, Half step up,
Drop D, Drop C, Drop C# — and drops a labelled six-string scaffold in that tuning, high
string on top:

```
e|-------
B|-------
G|-------
D|-------
A|-------
E|-------
```

Double-click to edit — extend each line as far as you need and replace dashes with fret
numbers, e.g. turning `-------` into `-3---0--2`. Resize and reposition it like any other
element. It's display only: nothing plays it, checks it, or reads it as music, same as
chord text elsewhere in the app — the scaffold is bare structure (string names and dashes),
not content. The tuning list is fixed reference data, same status as the theme presets —
nothing detects or infers a tuning from anything, you pick one from a list.

Editing a line by hand leaves the others short. The **Complete** button in the right rail
(when a tab is selected) pads every line out to match the longest one, so ragged edits
close back up into a clean rectangle:

```
---2              ---2-------
-----------  →     -----------
-------3---       -------3---
```

Only dashes get appended — nothing already typed moves.

While actively editing a tab (double-clicked, cursor in the box), a small **Bend** palette
appears in the bottom-right corner: **½**, **1**, **1½** for the common half-step,
whole-step and step-and-a-half bends, plus a field for any other amount — type it and
press Enter (or **+**) to insert it at the cursor. Either way it lands as a bare
number — `1/2`, `1`, `1 1/2`, or whatever you typed — not a spelled-out word, and never
"b"-prefixed: "b" already means *flat* in this app (Bb, Eb, and the tuning labels
themselves), so it can't also stand for "bend" in the same line without being ambiguous.

The font is fixed to monospace and doesn't wrap, because a tab diagram is an ASCII grid —
a proportional font or a rewrapped line breaks the vertical alignment between the strings,
so make the box wide enough to hold your longest line rather than relying on wrapping.

The assistant can see a tab element in the deck (so it won't mistake one for a shape) but
can't create, edit or style one — same reasoning as it never writing lyrics or chords.

## Stems — playing part of the mix

In the **Music sync** panel, press **Separate stems**. The song is split into drums, bass,
vocals and *other*, and a mixer appears with **M**ute, **S**olo and a level for each.

That gives you the things a class actually needs: mute vocals so students sing over the
real backing, solo the bass to drill a line, drop the drums to hear the harmony. The mix
carries into **Present**, so a deck presented with vocals muted stays that way.

Separation runs **in your browser** — nothing is uploaded. First use downloads a ~172MB
Demucs model, cached afterwards, and separating a song takes several minutes of hard CPU
work. Point `VITE_DEMUCS_MODEL_URL` at your own copy if you'd rather self-host it.

Three things worth knowing:

- **Guitar isn't its own stem.** The reliable model produces four sources and guitar lives
  inside *other*, along with keys and strings. A 6-stem model exists but separates worse
  across the board (piano especially bleeds), and the library used here supports four only.
- **Stems are an addition, never a replacement.** The full mix stays on disk, so a deck
  still plays if you remove them. "Remove stems" drops the reference, not the audio.
- **Stems cost space and memory.** They're stored as WAV (~10MB per stem-minute) and
  decoded into memory while playing — roughly 340MB for a four-minute song. Fine for one
  song; heavy for a long one.

The mixer is **session state**, deliberately not saved into the deck: muting vocals for a
rehearsal isn't a property of the presentation, and storing it would dirty the document
and clutter undo.

## Downloading a presentation

**⭳ Download** in the editor toolbar packs the whole presentation into one `.zip` —
`deck.json`, the audio, every image, and the cue times. **Import…** on the start screen
reads one back.

That's how you hand a deck to someone, move it to another machine, or keep a backup. It
matters most on Firefox and Safari, where the library lives inside browser storage and
there's no folder to copy.

The bundle is just the deck's own folder layout, zipped — unzip it and you'll find
`deck.json`, `audio.mp3` and `assets/`, no special format to decode. Import runs the same
schema and migration as every other reader, so an older bundle still opens, and the
imported deck gets a **new id** so it can never overwrite the original.

Separated stems are **excluded by default** — they're hundreds of megabytes and can be
regenerated by separating again. You're asked at download time, and if you leave them out
the stem references are stripped too, so the imported deck never points at audio that
isn't in the file.

## The assistant

Open **✨ Assistant** in the editor and type an instruction instead of clicking:

```
create intro verse1 pre hook chorus verse2 bridge chorus verse3
add chords C D E F to verses 1 2 3
cue the chorus at 2:22
make the intro a centered title
```

It proposes changes; you read them and press Apply. The whole batch lands as **one** undo
step, so a wrong guess costs one Ctrl+Z. Plan lines name the slides they actually resolved
to ("Verse 1, Verse 2, Verse 3"), which is how you catch a misread target *before* it
happens rather than after.

### Pasting a whole song's worth of content

Paste section-tagged text straight into the assistant and it distributes it across slides,
creating any that don't exist yet:

```
[Intro]
your text here

[Verse 1]
your text here

[Chorus]
your text here
```

Each block fills the slide of that name, or makes one. Shift+Enter for a newline inside
the box; Enter sends.

### Song details

Ask for a song's details and it looks them up rather than guessing:

```
add the metadata for Some Song by Some Band to the title slide
```

With a language model configured (see "Two engines" below), the model itself decides it
needs a lookup and asks for one — reading past typos, filler words and destination clauses
("...to the title slide") to work out the actual song. The store then searches Genius and
resumes the model with what it found, in one of three ways:

- **A confident match** — the model gets the facts and writes them, no interruption.
- **Only weak matches** — Genius returned something, but nothing the scorer trusts (it
  indexes user collection pages as songs, so blindly taking the top hit once put a
  stranger's music-collection page on a title slide). You're shown the candidates and pick
  one, or say **None of these**.
- **Nothing at all** — the model is told the search failed and answers honestly instead of
  inventing details. It previously filled slides with placeholder text like
  `(song name) metadata`; that's now explicitly forbidden.

Without a model configured, the same request is handled by pattern-matching in
`src/agent/lookup.ts` instead — it extracts a query from common phrasings and does one
direct lookup, without the candidate picker (a match either clears the confidence bar or
it doesn't).

Either way it fetches title, artist, album and year from Genius. Needs
`GENIUS_ACCESS_TOKEN` in `.env` (free from
[genius.com/api-clients](https://genius.com/api-clients) — the *Client Access Token*),
then a dev-server restart.

The browser can't call Genius directly: the required `Authorization` header triggers a
CORS preflight that Genius answers with 403, which surfaces as a bare "Failed to fetch".
Requests therefore go through a dev-server proxy (`/api/genius`, see `vite.config.ts`),
which makes them same-origin. A useful side effect: the token is injected server-side and
**never enters the browser bundle**, unlike the OpenAI key.

Metadata only — Genius has no lyrics endpoint. For lyrics, paste them yourself using the
`[Section]` blocks above.

**The assistant never supplies the words.** It has no internet access and is explicitly
instructed not to produce lyrics, chords or analysis of its own — it only lays out text
you give it. Bring lyrics from a source you're entitled to use.

### Two engines

**Built-in parser** (default, always on). Free, instant, offline, no account. Understands
the documented command shapes above — and *only* those. It will not handle typos or
several requests in one sentence.

**Language model** (optional, ⚙ in the panel). Handles free-form phrasing, misspellings
and compound instructions like *"create verse 1 slide the pre hook then chrus, in the
intro add key f#m"* — three requests and a typo, which no regex grammar will ever parse.
It receives a toolbook of every operation the editor supports and returns a plan in the
same format the parser does.

**Setup with an OpenAI key:**

```bash
cp .env.example .env      # then paste your key into VITE_OPENAI_API_KEY
npm run dev               # restart if it was already running
```

That's it — the assistant picks the key up automatically and the ⚙ panel confirms it's
using `.env`. Keys entered through ⚙ instead are stored in that browser only and take
precedence over `.env`; **Reset** there clears the override and falls back to the file.

> **`.env` is not a secret store.** Vite substitutes `VITE_*` variables into the JavaScript
> bundle at build time, so the key ends up as a literal string in the shipped files and is
> readable by anyone who opens devtools. That's fine for running locally, which is what
> this app is for. `.env` is gitignored.
>
> There is no way around this in a browser — obfuscating or encrypting the key doesn't
> help, because the code that unwraps it also ships to the browser. A key that reaches a
> browser is readable by whoever is at that browser. The only real fixes are: each user
> supplies their own key (⚙, stays in their browser), or a server holds the key and the
> browser calls that instead — and a proxy without auth and spend caps just leaks your
> credits more slowly.
>
> **`npm run build` therefore refuses to run while a real key is in `.env`**, so a stray
> build can't be published with your key inside it. Remove the key and rebuild to publish;
> use `ALLOW_BUNDLED_KEY=1 npm run build` when you deliberately want a local-only
> production bundle. `npm run dev` is unaffected.

Point it at any OpenAI-compatible endpoint, which is what puts the cost decision in your
hands:

| Endpoint | Cost | Notes |
|---|---|---|
| **Ollama / LM Studio** on localhost | Free | Runs on your machine, works offline, no account. Ollama needs `OLLAMA_ORIGINS` set to allow the page's origin. |
| **Groq** | Free tier | Your own key. |
| **OpenAI** | You pay per use | Your own key. |

Your key is sent nowhere but the endpoint you chose. The parser always runs first, so
anything it understands never reaches a model — and never costs anything.

### From the CLI, via MCP

An MCP server exposes the same editing operations to Claude Code, Codex, or any MCP
client, so you can build decks from a terminal against the same library folder the editor
uses.

```bash
npm run mcp:build      # compiles the server to dist-mcp/
```

Then register it. **Claude Code** — `.mcp.json` in your project, or `claude mcp add`:

```json
{
  "mcpServers": {
    "libre-off": {
      "command": "node",
      "args": ["/absolute/path/to/libre_off/dist-mcp/mcp/server.js",
               "--library", "/absolute/path/to/your/library"]
    }
  }
}
```

**Codex** — the equivalent block in `~/.codex/config.toml`:

```toml
[mcp_servers.libre-off]
command = "node"
args = ["/absolute/path/to/libre_off/dist-mcp/mcp/server.js",
        "--library", "/absolute/path/to/your/library"]
```

The library path is the folder you opened in libre-off — the one containing `decks/`.
`LIBRE_OFF_LIBRARY` works instead of `--library` if you prefer an env var.

**Tools:** `list_decks`, `read_deck`, `describe_capabilities`, `create_deck`, `apply_ops`
(with `dryRun`), `delete_deck`.

`apply_ops` takes the exact same `Op` vocabulary the in-app assistant uses, runs it through
the same pure `applyOps` transform, and validates against the same `Deck` schema — a third
producer of one contract rather than a parallel implementation. A deck built from the CLI
is indistinguishable from one built by hand, and no capability can drift between them.

Two caveats. **Only real-folder libraries work** — an IndexedDB library (the Firefox/Safari
fallback) lives inside the browser and is unreachable from a terminal. And **there is no
undo on disk**: the editor's Ctrl+Z only covers the running session, so use `dryRun` first
when a plan is large. Reload the deck in the editor to see CLI changes.

### What it can change

Structure (create / rename / reorder / delete slides, layouts), content (titles, body
text, speaker notes), cues (`cue the chorus at 2:22`), and design (deck theme, per-slide
background colours, text size / weight / alignment / colour). Images and element
positioning stay manual.

**It operates the app; it does not analyse music.** Chords and lyrics are placed exactly as
you type them — nothing infers a key, a progression, or a song structure. That's the same
hand-authored rule the rest of the project follows.

### Why there's no "sign in with ChatGPT" button

The obvious idea — OAuth into ChatGPT so the assistant is free — doesn't work, and it's
worth writing down so it isn't attempted again:

- **"Sign in with ChatGPT" is an identity provider.** It returns name, email and profile
  picture. It grants no inference.
- **Subscription-backed model calls are first-party**: Codex CLI, the IDE extension, Codex
  Cloud. Asked directly whether a third-party client may do the same, OpenAI confirmed the
  *code* is Apache-2.0 but pointed at the standard terms and gave no approval — and those
  terms restrict accessing the service by automated or programmatic means.
- So libre-off **never reimplements that OAuth flow**. It would mean presenting OpenAI's
  first-party client credentials from a client that isn't theirs, it breaks the moment they
  rotate a client id, and the exposure lands on the *user's* ChatGPT account.

Instead the assistant runs a **deterministic command parser** — free, instant, offline, no
account — which handles the documented shapes above. For anything beyond them, the provider
interface (`src/agent/providers/`) takes a language model:

- `codexCli.ts` — invokes the official Codex CLI *the user already installed and signed
  into*. Nothing is forged: OpenAI's own client, the user's own login, their own machine,
  and `codex exec --output-schema` returns exactly the JSON op list we need at no API cost.
  Requires a subprocess, so it activates only in the desktop build.
- A key-based provider can be added the same way, where the user pays their own tokens.

Every provider emits the **same** op list, validated by the same schema, so preview, undo
and the tests never learn which engine answered.

## Decisions worth not re-litigating

**Why not fork LibreOffice Impress?** It was asked, and the answer is feasibility, not
licence. LibreOffice core is MPL-2.0 and would permit reuse. But Impress is ~10M lines of
C++ whose `sd/` module is entangled with `svx`, `editeng`, `sfx2` and `vcl` through UNO;
it does not build standalone and has no web target. There is no "presentation module" to
lift out of the GitHub mirror. What *is* reusable is the ODF format itself (`.odp` is a
ZIP of XML) and headless `soffice` as a converter — both are import/export concerns, on
the roadmap below. The editor is hand-built React that mirrors Impress's arrangement.

**One renderer at three scales.** `SlideRenderer` draws a slide at a fixed 1280x720; the
editor canvas, the thumbnail rail, and fullscreen presentation mount that same component
and pass a different `scale`. Storing positions in screen pixels or percentages instead is
exactly how a slide editor ends up looking different when you present it than when you
built it.

**Backgrounds are a union, not a color.** `Background` is either `{ kind: "color" }` or
`{ kind: "image", src, fit, dim }`, used both by `theme.background` (the deck-wide master
backdrop) and `slide.background` (a per-slide override; leave it unset to inherit). `dim`
paints black over the image beneath the slide's elements — photographic backdrops swallow
text, and without a dimmer the only fix is editing the image outside the app.

**Undo is a snapshot swap.** Every mutation in `deckStore` is a pure `Deck -> Deck`
transform funnelled through one `commit()` that pushes the previous deck onto a stack. No
per-action inverse operation to write, and none to get subtly wrong.

**JSON is the source of truth in V1, not Markdown.** Markdown + YAML frontmatter is the
right long-term home — an Obsidian vault the user already knows how to navigate — but it
costs parsing, schema sync, and YAML edge cases during the exact phase where the schema
changes weekly. The migration is kept cheap by three constraints, all already honored:

- one file per song (`songs/<id>/song.json`), so migration is a per-file transform
- prose is segregated into exactly two fields (`song.notes`, `section.notes`), so the
  frontmatter/body split is mechanical
- stable UUIDs and `schemaVersion`, so links survive and the transform is a written function

The eventual mapping: everything except `notes` becomes YAML frontmatter (YAML is a
superset of JSON, so this is nearly a rename); `song.notes` becomes the document preamble;
each `section.notes` becomes a `## <section name>` heading in the body.

**Progression is stored separately from the chord chart.** `section.progression` is an
ordered list of chord symbols — the graph's only input. A `chordChart` block is *layout*:
bar lines, splits, repeat labels. One section may carry several charts (verse variations)
but has exactly one progression. Conflating them makes the graph depend on presentation.

**Rotations are not identical.** `I-V-vi-IV` and `vi-IV-I-V` share a cyclic sequence but
differ in harmonic function and feel. The original sequence is stored verbatim; the
canonical rotation is *derived at index time* (`theory/rotation.ts`, genuine Booth's
algorithm — cross-checked against brute force over 200 random trials in tests) and never
touches the song file. Same rule for roman numerals (`theory/roman.ts`): derived from
progression + effective key, with `section.romanNumerals` as a manual override for cases
where the label is an interpretation (secondary dominants, borrowed chords) rather than a
lookup. The derivation is necessarily best-effort — exact for diatonic chords, nearest-degree
with an accidental for chromatic ones — which is exactly what the override field is for.

**Nothing derived is stored in the song file.** It holds authored truth only. Anything
computable — roman numerals, canonical rotations, n-grams, edge weights — is index data
and gets rebuilt on scan. That is what makes changing the matching algorithm a re-index
instead of a migration.

**Section key is an explicit field, and it matters more than it looks.** A section whose
chords are nominally in C major but which *functions* in A minor must say so. Key is
hand-entered, and a wrong key silently poisons every graph edge derived from that section.
The example song is built around this case.

**Sections are sorted and non-overlapping, enforced at parse time.** The sync engine
binary-searches the array at 60fps and assumes one active section; the invariant is
cheaper to enforce at the boundary than to defend against in the render loop.

## Edge taxonomy

Implemented in `graph/index.ts` (11 tests), checked strongest-to-weakest so each type is
"matches at this level **and** fails the stronger one" without separate exclusion logic:

1. **Same Progression** — identical roman numerals, with a `transposition` attribute
   (semitones; 0 = same key, which is a filter for "same fingerings", not its own edge type)
2. **Quality Variant** — same skeleton, different qualities/extensions (`ii-V-I` vs `iiø-V-i`)
3. **Same Harmonic Loop** — canonical rotation matches but the original does not
4. **Partial Overlap** — shared n-gram ≥ 4, IDF-weighted

Deduped to one edge per section pair — otherwise every strong match also draws as three
weak ones.

Typing edges makes the "why are these related?" panel writable — one explanation string per
edge — but noise control is two separate mechanisms, both in `graph/index.ts`: IDF weighting
on Partial Overlap edges (`+1`-smoothed since the corpus is rebuilt fresh each call, not
persisted), and `topKPerNode()`, applied at render time in `GraphView.tsx`, which keeps an
edge if *either* endpoint ranks it in its own top 8 — a union, so a sparsely-connected node
doesn't lose its one edge just because the node on the other end has stronger options
elsewhere.

## Audio sources

`song.audio` (`AudioRef` in `schema/song.ts`) is a local file: a path relative to the
song's own folder, decoded in the page so WaveSurfer can draw a real waveform and
sections can be marked by dragging on it.

It is **optional** as of song schema v3. A song with no audio still opens — its sections
and analysis are intact — it just has nothing to play. That state exists because v3
removed an earlier YouTube-embed source; the migration drops the audio and preserves the
video id in `song.notes` rather than discarding the reference.

That removal was worth it twice over: an embedded video is opaque to the page, so it
could never produce a waveform, and being a cross-origin iframe it blocked the
cross-origin isolation that in-browser stem separation needs.

The boundary that remains is deliberate and permanent: **the app plays audio, it does not
acquire it.** Nothing will be added that downloads, rips, or transcodes audio from a
streaming service.

## The adapter boundary

`LibraryAdapter` in [types.ts](src/adapters/types.ts) is the entire platform surface.
Everything above it is plain browser code — React, WaveSurfer, the theory engine, the
graph. **No `fs`, `path`, `child_process`, or Electron imports in the renderer, ever.**

That rule buys two things: `vite dev` in Chrome stays the daily loop with real HMR and
devtools, and shipping on Electron later is a second implementation of one file rather
than a port. When you want the filesystem, add a method here — don't reach around it.

Two implementations exist today, chosen by `createLibraryAdapter()` in
[adapters/index.ts](src/adapters/index.ts):

- **`BrowserLibraryAdapter`** — File System Access API, a real folder on disk. Chromium
  only (Chrome, Edge, Brave); no directory picker in Firefox or Safari.
- **`IndexedDbLibraryAdapter`** — works in every modern browser, including Firefox and
  Safari, by storing songs and audio as Blobs in IndexedDB instead of real files. This is
  what makes "every browser" true, but it's a real trade-off, not a strict upgrade: no
  folder to point Finder/Explorer at or back up by copying, and clearing site data deletes
  the library. `navigator.storage.persist()` is requested best-effort to reduce eviction
  risk, but browsers (Safari especially) can still decline it. `libraryStore.ts` exposes
  `usingFallbackStorage` so the UI can say so plainly rather than hiding the difference.

Neither can read outside the library root — absolute audio paths throw `out-of-root` by
design (`adapters/paths.ts`, shared by both, tested). The Electron adapter is what users
eventually get, and it additionally allows absolute audio paths and can spawn headless
LibreOffice for ODP rendering.

## Library layout on disk

```
<library-root>/
├── decks/                    the presentation editor
│   └── <deck-uuid>/
│       ├── deck.json         slides, elements, theme, cue times
│       ├── audio.mp3         the track the deck is cued against
│       └── assets/           images inserted onto slides
└── songs/                    song-study mode
    └── <song-uuid>/
        ├── song.json
        ├── audio.mp3
        ├── assets/           images, diagrams
        └── .cache/
            └── peaks.json    waveform peaks, so reopening never re-decodes
```

## Known gaps

**Presentation editor**
- No ODF (`.odp`) import or export yet, and no PDF export.
- No presenter view — `slide.notes` is editable but nothing displays it during
  presentation.
- Text is plain, not rich: styling applies per text box, not per word or per paragraph.
- No slide transitions or per-element animation. Deliberate for now.
- No group/ungroup — multi-select and its commands (align, arrange, distribute, nudge)
  cover most of what grouping is normally for, but there's no way to save a group as a
  unit and move it as one object across edits. Would need a nested-element schema change.
- Tab elements are placement only — no playback, no chord/fret checking, and the
  assistant can't create or edit one yet (manual, via the toolbar's **+ Tab**).
- Dragging a rotated element still moves it along unrotated (x/y) axes, not along its own
  rotated ones.
- Audio is whatever the browser can decode; only MP3 is verified.
- Background images aren't garbage-collected: swapping a slide's backdrop leaves the old
  file in `assets/`. Harmless but it accumulates; deleting the deck clears it.
- Uploaded images are stored as-is — no downscaling, so a 12MP photo used as a backdrop is
  stored and decoded at full size.

**Assistant**
- Without a model configured, the built-in engine is a grammar: it understands the
  documented command shapes and says so plainly when it doesn't. Typos and multi-part
  sentences need a model.
- No conversation memory. Each instruction is interpreted against the deck alone, so
  "now do the same to the bridge" won't work; repeat the full instruction.
- Small local models are noticeably worse at emitting valid operations than hosted ones.
  If a plan looks wrong, that's usually the model, not the parser — the reply is schema-
  validated, so a bad one is rejected rather than applied.
- Image backdrops and element positioning aren't in the op vocabulary. A model can't
  upload a file, so those stay in the properties panel.
- The Codex provider is written but inert until the desktop build exists — a browser tab
  can't spawn a subprocess. `available()` returns false and it never appears in the panel.

**Song-study mode**
- `text` blocks render as plain text, not GFM markdown.
- `guitarChord` and `image` blocks are in the schema with no renderer.
- The graph index is in-memory, not SQLite — `better-sqlite3` is a native module and can't
  load in a browser tab. Same shape (`{ nodes, edges }`), rebuilt on demand.
- The graph rebuilds on a button, not live.
- Songs migrated from the removed YouTube source have no audio. They open and keep their
  sections and analysis, but can't play until a local file is attached.

## Next

1. Presenter view — speaker notes and next-slide preview on a second screen.
2. ODF export, then import (`.odp` is a ZIP of XML).
3. PDF export — likely a print stylesheet over `SlideRenderer`.
4. Electron adapter: absolute media paths, a `better-sqlite3`-backed graph index.
