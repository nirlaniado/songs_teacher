# songs-teacher

**A presentation editor whose slides follow the music.** Build slides, attach an MP3, and
cue each slide to a moment in the song (intro at 0:00, verse at 1:20, chorus at 2:22).
Press Present and the track plays while the deck advances itself — built for music
teachers who want to talk over a song instead of clicking through it.

Optional extras: an Ultimate Guitar agent that fetches a song's chords and turns them into
a deck, in-browser stem separation (mute vocals, solo bass), and a song-study mode.

## Quick start

```bash
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173), then choose a folder to keep
your presentations in.

**With the Ultimate Guitar chord agent** (needs the credentials listed below):

```bash
npm install
npm run ug:install-browser
npm run dev:agent
```

**Other commands**

```bash
npm test             # unit tests
npm run typecheck
npm run build        # typecheck + production build
```

## What you need

| For | You need |
|---|---|
| The editor | Node.js 22+ and a modern browser. Chrome/Edge/Brave store real files in a folder; Firefox/Safari keep work in browser storage. |
| Music sync | An MP3 you already have. The app plays audio; it never downloads it from YouTube or Spotify. The automatic sync sends the MP3 (audio only) to OpenAI for a transcript, using the chord agent's `OPENAI_API_KEY`; without it the slides are timed from the music alone. |
| Chord agent (optional) | An OpenAI API key with access to `gpt-5.4-mini`, and your Ultimate Guitar username and password, in a `.env` file (see below). |
| Stem separation (optional) | A ~172MB model, downloaded once on first use, plus several minutes of CPU per song. Nothing is uploaded. |

`.env` (only for the chord agent — copy `.env.example` and never overwrite an existing one):

```dotenv
OPENAI_API_KEY=your-key
ULTIMATE_GUITAR_USERNAME=your-username
ULTIMATE_GUITAR_PASSWORD=your-password
```

## Project layout

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
│   ├── playerStore.ts  song-study playback clock, ticked by rAF
│   ├── libraryStore.ts song-study library
│   └── graphStore.ts   builds the harmonic graph on demand
├── components/
│   ├── DeckLibraryScreen.tsx   start screen
│   ├── DeckScreen.tsx          the editor window + Focus mode (full-screen editing)
│   ├── deck/                   SlideRenderer, SlideCanvas (multi-select, snapping,
│   │                           marquee, rotate), CanvasContextMenu, SlidePanel,
│   │                           EditorToolbar, PropertiesPanel, TimingPanel,
│   │                           PresentMode, StemMixer, SeparateStems,
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
```

## Ultimate Guitar chord agent

The **סוכן אקורדים · Ultimate Guitar** button is available on the start screen,
even before opening a library. The agent uses your Ultimate Guitar account as its
only chord source. GPT-5.4 mini identifies the song and calls a constrained search
tool; local TypeScript code chooses the version and extracts the actual chart.
Credentials and chart content are never sent to the model. Only the user's song
request is sent to OpenAI for the search; the MP3 is sent (audio only) when you create a
presentation, for a transcript (see below). API usage is billed separately from the UG subscription.

Setup is in **Quick start** and **What you need** above. Optionally set
`UG_AGENT_MODEL=gpt-5.4-mini` and `UG_TRANSCRIBE_MODEL=whisper-1` in `.env` to choose the models.

Once a chart is found, choose the song's MP3 (required) and press **Create Presentation**. It
builds a deck — a title slide plus one slide per song section, with the chords over their lyrics
in a monospace block — and syncs it to the song in the same step. Needs a library folder open
first.

**How the sync works.** The agent keeps each section's lyrics from the chart. When you press
**Create Presentation**, the MP3 is sent (audio only) through your local agent service to OpenAI,
which returns a timestamped transcript of the singing. Your chart's lyrics are then matched to
that transcript *on your machine* — nothing about the chart is sent. Each section starts where
its lyrics are found, in song order (so a repeated chorus lands on its own repeat), and the time
is snapped to the nearest real change in the music. Instrumental sections have no words to find:
an **Intro** takes over from the title slide after a 3-second hold, and a solo or outro starts
where the singing before it ends. This uses your `OPENAI_API_KEY` and costs a small amount per
song; the audio is sent as 16 kHz mono, which keeps a song under OpenAI's 25 MB limit.

If the transcript can't be made (service down, quota, an instrumental) or too few sections are
found in it, the slides are timed from the music alone (where the harmony changes), and you are
told. That is rougher. Either way it is a starting point: a recording that differs from the chart
(a skipped bridge, an extra chorus), or one Whisper mishears badly, can still land wrong. Check by
ear and fix any cue with **Set** in the **Music sync** panel. **Auto-suggest cues** there re-times
from the music alone (a deck doesn't keep the chart's lyrics apart from the slides' text); one
Ctrl+Z undoes the whole batch. If the sync fails entirely, the deck is still created with the MP3
attached and no cues.

Open the Vite address shown in the terminal, then the chord agent. Example input:
`VIVA LA VIDA — COLDPALY`. Alternatively run `npm run ug:server` and `npm run dev`
in separate terminals. Restart the agent after changing its code or `.env`.
The Vite dev/preview server proxies `/api/ug` to the loopback-only service on 4318;
this personal account service is not designed for public deployment.

The browser signs in once and keeps its session in `.ug-agent/profile`. On a desktop
it opens a visible window; on Linux without a display it defaults to headless.
For a CAPTCHA or extra authentication, run with `UG_HEADLESS=false` on a machine
with a display, finish the site's prompt, then press **השלמתי התחברות — המשך**.
Do not run two agents against the same profile simultaneously.

Selection and provenance:

- Search all result pages (up to 10; broader searches stop with an explicit error).
  Match title and artist, deduplicate marketing rows by their linked Official ID.
- Prefer a version explicitly marked Official. For an authenticated Official tab,
  click the site's **Chords** toggle and extract only named chord spans inside the
  chart. A failure does not silently fall back to community content.
- When no Official result exists, inspect each matching Chords page and compare
  `tab_view.stats.view_total`. Votes and star ratings are not view counts. An
  Official link discovered on a community page takes precedence too.
- Missing view counts, ties, multiple Official versions, or ambiguous song matches
  prompt a choice. Network errors and incomplete searches stop the lookup.
- Every community result carries a visible Hebrew warning that it is unofficial
  and may contain inaccuracies. Results include source URL, version, views, selection
  reason, retrieval time, capo/tuning/key when available, sections and chord order.

Charts keep the lyrics under each chord line (the ones on the page your account opens), preserve
source chord order/repetitions, and can be copied or downloaded as JSON. Results are also written atomically to `.ug-agent/results/<id>.json`.
Each new lookup rechecks the site; saved results are an archive, not proof of current
popularity. All `.ug-agent` contents are ignored by Git. Treat the profile as a secret;
it contains your logged-in session. No passwords, cookies, or raw provider errors are
returned through the local API. Never put API keys in `VITE_*` variables.

Site markup can change. The extractor fails explicitly when it cannot verify the
source or read chord notation; it does not infer chords from audio or score images.
Initial live verification covered the authenticated Official chord view for
Coldplay's Viva La Vida. Automated tests also cover selection, missing statistics,
source mismatches, login recovery, and failures without unofficial substitution.

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
panel and music panel each have their own toggle inside focus mode, so you can strip down to
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

## Decisions worth not re-litigating

**The app owns the editor.** Slide content, rendering, editing and persistence use the
native React/TypeScript implementation. The experimental LibreOfficeKit integration has
been retired; no LibreOffice runtime, C++ host or separate document server is required.
Future office-format support should use the app's own document model without restoring
that dependency.

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
design (`adapters/paths.ts`, shared by both, tested). A future desktop adapter could
add absolute media paths while retaining the same native editor.

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
- Tab elements are placement only — no playback and no chord/fret checking. They are
  added from the toolbar's **+ Tab**.
- Dragging a rotated element still moves it along unrotated (x/y) axes, not along its own
  rotated ones.
- Audio is whatever the browser can decode; only MP3 is verified.
- Background images aren't garbage-collected: swapping a slide's backdrop leaves the old
  file in `assets/`. Harmless but it accumulates; deleting the deck clears it.
- Uploaded images are stored as-is — no downscaling, so a 12MP photo used as a backdrop is
  stored and decoded at full size.

**Song-study mode**
- `text` blocks render as plain text, not GFM markdown.
- `guitarChord` and `image` blocks are in the schema with no renderer.
- The graph index is in-memory, not SQLite — `better-sqlite3` is a native module and can't
  load in a browser tab. Same shape (`{ nodes, edges }`), rebuilt on demand.
- The graph rebuilds on a button, not live.
- Songs migrated from the removed YouTube source have no audio. They open and keep their
  sections and analysis, but can't play until a local file is attached.

## Product direction and next steps

The native editor, document schema and playback engine are the foundation. Everything on
a slide is authored by the user; the chord lookup agent is separate from slide editing
and does not generate or modify presentations.

Editor work to consider next: presenter view, richer text and grouping, and export/import
implemented around the native document model. Detailed priority is still to be decided.
