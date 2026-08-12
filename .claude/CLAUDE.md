# libre-off

## What this is

**A presentation editor for music teachers.** The primary app is a slide editor in the
mould of LibreOffice Impress — slide rail, canvas, properties sidebar, layouts, themes —
plus one thing Impress has no equivalent for: you attach a song and cue each slide to a
timestamp in it. Press Present and the track plays while the deck follows along, so a
"song presentation" (intro at 0:00, verse 1 at 1:20, chorus at 2:22) runs itself while
the teacher talks over it.

Three ways to drive it: by hand, by typing instructions to an in-app assistant, or from a
terminal over MCP (Claude Code / Codex).

Secondary and older: a song-study mode for marking sections of a track and writing
harmonic analysis, plus a knowledge graph linking songs by shared harmony. Still works,
reachable from the start screen, no longer what the app is for.

### Non-negotiables

- **No *musical* inference.** Nothing detects chords, infers keys, or derives structure
  from audio. Analysis is authored by hand.
  *Amended:* an earlier blanket "no audio-ML" rule was retired by the user to allow stem
  separation. Separation transforms audio for playback — it does not analyse it — so the
  narrower rule above is the one that binds. Do not read "stems" as licence to add chord
  or key detection.
- **Audio is played, never acquired.** Nothing downloads, rips or transcodes audio from a
  streaming service. (The YouTube player was removed entirely in song schema v3.)
- **The assistant places text; it never writes content.** It does not produce lyrics,
  chords or analysis. Users paste what they hold rights to. See "Lyrics" below.
  *Extends to tab notation:* a slide's `tab` element is pasted verbatim, same as chords.
  Nothing parses it as fretboard positions, transposes it, or checks it against a chord —
  it is a block of text with a monospace font forced on it, not a musical object.

### About the name

`libre_off` refers to LibreOffice, but **we do not vendor or fork it.** Asked three times,
so settled here: Impress is not separable (`sd/` is entangled with `svx`, `editeng`,
`sfx2`, `vcl` via UNO), it's ~10M lines of C++, and it has no web target — there is no
"presentation module" to lift out of the GitHub mirror. Licensing was never the blocker
(MPL-2.0 would permit reuse); **portability** is.

What we *do* copy is the **interaction design**: the arrangement of the panels, the names
of the commands, the keyboard shortcuts, and the rules that make them feel right (see
"The editing surface" below). Someone who knows Impress should find things where they
expect them. The implementation underneath is hand-built React.

LibreOffice's remaining role is narrow and optional: ODF as an import/export format
(`.odp` is a ZIP of XML), and headless `soffice` as a converter. Both are future work.

---

## Architecture

Seven load-bearing ideas. Everything else is detail.

### 1. One renderer at three scales

`SlideRenderer` draws a slide at a fixed **1280×720**. The editor canvas, the thumbnail
rail and fullscreen presentation all mount *that same component*, differing only in the
`scale` prop.

*Why:* storing positions in screen pixels or percentages is exactly how a slide editor
ends up looking different when you present it than when you built it. One coordinate
space, converted to pixels only at the edge, makes that class of bug impossible. Pointer
deltas divide by `scale` at the point of use.

`ElementView`'s text and tab branches shrink their font to fit the box (`FitText`,
`useShrinkToFit`) rather than clipping — PowerPoint's "shrink text on overflow". Dragging
a box smaller used to just crop whatever no longer fit; now the text scales down instead,
which is what dragging a handle inward actually reads as. Never stored — recomputed every
render from the box's current size via a hidden, off-screen probe clone (measuring with a
real DOM node rather than estimating from character counts, since a proportional font's
per-character width varies too much for a cheap approximation to reliably match real
wrapping). Because it lives in `ElementView`, it applies identically wherever
`SlideRenderer` mounts — canvas, thumbnails, Present — same as everything else here.

### 2. Undo is a snapshot swap

Every mutation in `deckStore` is a pure `Deck -> Deck` transform funnelled through one
`commit()`, which pushes the previous deck onto a stack (`HISTORY_LIMIT = 60`).

*Why:* the alternative — an inverse operation per action — means writing and maintaining
a correct undo for every feature forever. Snapshots cost memory we have and buy
correctness we'd otherwise have to earn repeatedly.

### 3. One op vocabulary, several producers

The assistant's contract is `src/agent/ops.ts`: a Zod discriminated union of operations
plus a `Target` union for addressing slides. **Three independent producers emit it:**

```
instruction
     ├─ deterministic parser   (grammar; free, instant, offline)   ← default
     ├─ language model         (any OpenAI-compatible endpoint)
     └─ MCP client             (Claude Code / Codex, over stdio)
                    ↓
              Op[]  ─→ validateOps (dry run + Deck.safeParse)
                    ─→ preview / describeOps
                    ─→ applyOps  (pure, whole batch, ONE commit)
```

*Why:* preview, validation, undo and tests never learn which engine answered. Adding a
producer touches nothing downstream, and a model physically cannot propose an operation
the app doesn't implement — malformed replies are rejected by the same schema, not
applied. This is the single most important structural decision in the codebase.

### 4. One player interface, two engines

`src/audio/` — `DeckPlayer` is what every screen talks to. `useDeckPlayer` picks the
engine from the deck (`ElementPlayer` for a plain track, `StemPlayer` for a separated one)
and **owns the rAF clock, once**.

*Why:* `TimingPanel` and `PresentMode` used to each own an `<audio>` element and a
near-identical clock, and the copy in `PresentMode` had a bug that killed playback after a
single frame. One clock means one place for that class of bug to live, and it's now fixed
there permanently. Screens just read `time` and call `seek`.

*Why Web Audio for stems:* four `<audio>` elements each run an independent clock and drift
apart within seconds — there is no way to hold them together. `AudioBufferSourceNode`s
started against one `AudioContext.currentTime` are sample-accurate by construction. The
cost is that those nodes are one-shot: pausing and seeking both mean discarding and
rebuilding them, which `StemPlayer` hides.

### 5. The adapter boundary

`LibraryAdapter` (`src/adapters/types.ts`) is the entire platform surface. Everything
above it is plain browser code.

*Why:* it keeps `vite dev` in a browser as the daily loop with real HMR, and turns
"ship on Electron" into a second implementation of one file rather than a port.

**Rule: no `fs`, `path`, `child_process` or Electron imports outside the adapter layer.**
Want the filesystem? Add a method to `LibraryAdapter`. The MCP server is Node and lives
*outside* `src/` precisely so this holds.

### 6. The model asks for a lookup; it never guesses

Understanding an instruction is the model's job, not a regex's. A reply may be
`{"lookup":{"query":"…"}}` instead of `{"ops":[…]}`; the store searches Genius and asks
once more, carrying the outcome:

```
instruction ─→ model ─→ {"lookup":{query}}
                            ↓
                     searchSongs(query)  →  scored candidates
                            ↓
      confident match ──────┼────── weak matches ────── nothing
             ↓              │            ↓                 ↓
    facts → model      (ask the user, then resume)   failure → model
             ↓                                              ↓
          ops[]                                  {"ops":[],"message":"not found"}
```

*Why:* intent detection was regexes in `src/agent/lookup.ts`, patched four times — typos,
trailing clauses, destinations, edit verbs — and each fix missed the next phrasing. A
model reads all of them correctly. It stays as the fallback when no model is configured
(`hasModelProvider()`), because a parser-only setup still needs *something*.

*Why exactly one round trip:* the provider ignores a second `lookup` once an outcome is
present. A model that dislikes a result would otherwise search in a loop, and every
attempt is a request the user pays for.

*Why ask instead of taking the best hit:* Genius indexes user collection pages as songs.
Trusting `hits[0]` is how "KamZ's Music Collection" reached a title slide. Hits are scored
by token overlap (`overlap`, prefix-tolerant so typos still match); below `MIN_CONFIDENCE`
the user picks from the candidates or says none fit — and "none fit" goes back to the
model as a failure, so the answer is "I couldn't find it", never an invention.

### 7. The editing surface is a selection plus commands over it

`selectedElementIds: string[]` in `deckStore` is the single source of truth for what is
picked. Every editing command — align, arrange, distribute, clipboard, nudge, delete —
reads that array and commits **one** `Deck -> Deck` transform, so a gesture is one undo
step regardless of how many elements it touched.

*Why an array and not an id:* align, distribute and "delete these three" are meaningless
on one element, and the agent's ops have taken `elementIds` from the start. A
single-selection UI was the narrower half of a vocabulary the app already spoke.

*Why the arithmetic lives in `src/deck/geometry.ts`:* snapping, marquee enclosure and
align offsets are exactly the kind of thing that is wrong by two units in a way a
pointer-driven UI never reveals. Pure functions, unit-tested, in slide units only.

Rules taken from Impress and worth keeping:

- **Marquee selects on enclosure, not intersection.** Selecting by touch means a band
  drawn across a slide grabs everything it brushes — the opposite of precise.
- **Several elements align to each other; one aligns to the page.** Without this,
  "centre" on a single shape is a no-op.
- **Snapping resolves once against the selection's bounding box**, then the correction is
  applied to every member — otherwise a group's elements each latch onto their own guide
  and the group deforms as it moves. **Alt suspends it** for one gesture.
- **Guides are drawn only where a snap actually matched.** A snap the user can't see
  reads as the editor moving things by itself.
- **Arrange moves a multi-selection as a block**, walking from the edge it is moving
  towards, so the block doesn't collapse onto itself and reshuffle.
- **Locked elements survive bulk commands** — align, distribute, nudge and delete all
  skip them. Locking exists precisely to stop that.
- **The clipboard is deep-cloned on copy** and pastes with fresh ids and a cascading
  offset. Duplicate ids break selection and z-ordering, both of which address by id.

**The `tab` element** (guitar/bass tab notation, `SlideElement`'s fourth kind) rides this
same selection/commands machinery for free — arrange, align, distribute, clipboard, nudge
all work on it already, because they only ever touch `Box` fields (x/y/w/h/rotation/
locked). Two things about it are deliberately narrower than `text`:

- **Font family is not a style choice.** `TabStyle` has no `fontFamily`, `bold`, `italic`
  or `underline` field, and the renderer forces a monospace stack (`TAB_FONT_STACK` in
  `SlideRenderer.tsx`) with `white-space: pre` (no wrap). Tab notation is an ASCII grid —
  a proportional font or a wrapped line breaks the vertical alignment between string
  lines, so these aren't style knobs the way they are on `text`.
- **The agent can see one but not create or edit one.** `describeDeck` labels it correctly
  (`kind === "tab"` has its own branch — the previous text/image/shape chain was an
  if/if/fallback, not an exhaustive switch, so a missed branch there silently mislabels
  a new kind as the last one checked). There is no `addTabBox` op; `setElementText` and
  `styleElements` are both guarded to `el.kind === "text"` and no-op on a tab element
  rather than erroring. Adding tabs to a slide is a manual step (the `+ Tab` button) —
  consistent with "the assistant never authors content" above, since generating tab text
  would be exactly that.
- **`+ Tab ▾` opens a tuning picker and seeds a labelled scaffold, not an empty box.**
  `TUNING_PRESETS` and `tabScaffold()` live in `deck/templates.ts`, next to
  `THEME_PRESETS` — same status: static reference data the user picks from, not
  inference. Covers Standard, Half step down/up, Drop D, Drop C, Drop C#, each as a
  fixed high-to-low string list (`tuningById`, defaulting to Standard for an unknown
  id). This is a UI convenience, not the rule above being bent: `e|-------` carries no
  musical information — a string name and dashes — the same way an empty table a word
  processor inserts carries no prose. The user still supplies every fret number by hand.
  The top string's label is lowercased and the rest aren't, consistently across every
  preset (not just standard's e/E), so the rule stays predictable rather than
  case-by-case; `templates.test.ts` pins the exact note names per preset — a wrong one
  (e.g. Drop C# spelled with the wrong accidental) is a worse bug than most, because nothing
  else in the app would ever notice it.
- **`padTabLines()` (`deck/templates.ts`) closes ragged edges.** Hand-editing one string's
  line leaves the others short; the Properties panel's **Complete** button pads every line
  out to the longest, appending only dashes — nothing already typed is touched or moved,
  so it can't reinterpret a fret number. Pure and unit-tested against the exact
  ragged-input example that motivated it.
- **The bend palette inserts at the caret, not at the end, and never with a "b" prefix.**
  `SlideCanvas.tsx` renders a small **½ / 1 / 1½** toolbar (`BEND_MARKS`) plus a free-text
  amount field in the canvas's bottom-right corner while a tab is being actively edited,
  splicing whatever's chosen — `1/2`, `1`, `1 1/2`, or anything typed into the field —
  into `editing.text` at `textarea.selectionStart`, verbatim, same as everywhere else in
  the app; there's no format validation on the custom field. No leading "b": "b" already
  means *flat* elsewhere in a tab (`Bb`, `Eb`, the tuning labels in `TUNING_PRESETS`
  itself), so `b1/2` would read as two different things depending on which line it's on.
  Three details make the insertion itself actually work:
  - **`selectionStart`/`selectionEnd` survive a blur.** They're properties of the
    textarea element, not tied to focus — reading them after focus has moved to the
    amount field still gives the caret position from when the user was last in the
    textarea, which is exactly where the insert should land.
  - **`bendPaletteRef` gates the textarea's `onBlur`.** Focus moving from the textarea to
    anything *inside* the palette (a preset button, the amount field, the insert button)
    must not read as "done editing" and close the whole overlay — checked via
    `bendPaletteRef.current.contains(e.relatedTarget)` before calling
    `setEditingElement(null)`. Genuinely clicking away still closes it. The preset
    buttons additionally keep `onMouseDown={(e) => e.preventDefault()}`, which stops
    them taking focus at all — belt-and-suspenders with the same effect, kept because
    it was already correct and there's no reason to disturb it, whereas the amount
    field *needs* focus (you're typing into it), so it relies on the `relatedTarget`
    check alone.
  - **`pendingCursor` restores the caret after the insert.** The textarea is controlled
    (`value={editing.text}`), so replacing it via `updateElement` — same as any edit —
    resets the browser's own caret to the end of the new value, and for the amount field
    also returns focus there from the field. A ref is set to the post-insert position
    before the update and consumed in the height-measuring `useLayoutEffect` (which
    already re-runs on every text change), so normal typing (which never sets it) is
    unaffected.
  Positioned fixed in the canvas corner, not tracked to the element: the element can be
  rotated and the canvas zoomed, and an overlay outside that transform is what stays a
  legible, constant size regardless.

---

## Tech choices and their trade-offs

Each was chosen against a real alternative. Don't substitute without a reason.

| Concern | Choice | Trade-off accepted |
|---|---|---|
| Slide rendering | **DOM elements** | Not canvas/WebGL. Gives text selection, inline editing, and printable output free; costs fine-grained pixel control we don't need. |
| Slide framework | **Hand-rolled React** | Not reveal.js: it owns the DOM and routing, and we drive navigation from an audio clock. Costs us writing the editor; buys full control of the sync engine. |
| Coordinate space | **Fixed 1280×720 units** | Not percentages/responsive. Costs a scale calculation; buys pixel-identical editing and presenting. |
| Validation | **Zod** | Schema and TS types from one definition. Runtime cost on parse; buys a single source of truth that the MCP server, the browser and the tests all share. |
| State | **Zustand** | Not Redux (ceremony) or Context (re-render storms). Selector-based subscription is what keeps a 60fps clock out of the render tree. |
| Playback clock | **`requestAnimationFrame`** | Not the `timeupdate` event, which fires ~4×/sec — a slide cued to a downbeat would visibly arrive late. |
| Desktop (planned) | **Electron**, not Tauri | Tauri's OS webview means codec support varies per platform — unacceptable for an audio app. Electron bundles Chromium; costs bundle size. |
| Browser storage | **File System Access API**, IndexedDB fallback | Real files where possible. IndexedDB keeps Firefox/Safari working but has no folder to back up and dies with site data. Not a strict upgrade — surfaced in the UI, not hidden. |
| Graph index | **In-memory**, not SQLite | `better-sqlite3` is a native module that cannot load in a browser tab. Same `{nodes, edges}` shape, rebuilt on demand; swappable in the Electron phase. |
| Assistant default | **Deterministic parser** | A grammar, not a model. Free, instant, offline, no account — so common commands never cost anything. Costs coverage: typos and compound sentences need the model tier. |
| Assistant model tier | **Any OpenAI-compatible endpoint** | Not hard-wired to OpenAI. The endpoint decides who pays: local Ollama is free, a hosted key is the user's. One request shape covers all. |
| Intent detection | **The model asks for a lookup** | Not regex phrase-matching, which needed a patch per phrasing and still misread typos and compound sentences. Costs one extra round trip when a song is involved; the regexes survive only as the no-model fallback. |
| Uncertain song match | **Ask the user** | Not the top hit (Genius indexes collection pages as songs) and not silent failure (a typo'd query often has a right answer one click away). Costs an interruption, only when the scorer isn't confident. |
| MCP transport | **stdio, compiled to JS** | Not `vite-node`/`tsx`: a dev runner's banner on stdout corrupts the JSON-RPC stream. Costs a build step; buys a clean channel. |
| Deck writes (Node) | **temp file + `rename`** | `writeFile` truncates and refills, so a shorter write over a longer one leaves the old tail and corrupts JSON. Observed in testing, not theoretical. |
| Multi-track sync | **Web Audio buffers**, not `<audio>` elements | Media elements each run their own clock and drift within seconds. Buffer sources started against one context clock are sample-accurate. Costs memory (~85MB per decoded 4-min stem) and one-shot nodes that must be rebuilt to seek. |
| Stem separation | **In-browser ONNX** (`demucs-web` + `onnxruntime-web`) | Not a Python/Node service: self-contained, nothing to install, nothing uploaded. Costs a ~172MB model download (cached) and minutes of CPU per song. Needs COOP/COEP for `SharedArrayBuffer`. |
| Separation library | **`demucs-web`**, not hand-ported inference | It owns STFT (4096/1024), reflect padding, segmentation and overlap-add — all easy to get subtly wrong. Costs: it hardcodes four sources, so a guitar stem isn't available. |
| Stem storage | **WAV** | Trivial to encode with no dependency; the browser has no non-realtime MP3/Opus encoder. Costs ~10MB per stem-minute on disk. |
| Isolation policy | **COEP `credentialless`**, not `require-corp` | `require-corp` blocks cross-origin subresources that don't opt in, which would break fetching the model from Hugging Face. |
| Lyrics | **User paste only** | Genius has no lyrics endpoint (metadata only); "lyrics libraries" scrape HTML against its terms. Licensed APIs (Musixmatch/LyricFind) need commercial terms. So: users paste, the app lays out. |

---

## Workflows

### Building a song presentation (the product)

1. Open a folder as the library (Chromium keeps real files; Firefox/Safari fall back to
   browser storage).
2. Create a presentation → you get a title slide.
3. Build slides: layout from the right rail, double-click text to edit, insert
   images/shapes, drag and resize. Editing works the way Impress does — see below.
4. Set a backdrop — deck-wide via **Master / theme**, or per-slide. Colour or a saved
   image, with fit mode and a **Dim** slider so text stays readable over a photo.
5. **Music sync** panel: add an MP3.
6. Play it. When the song reaches the moment a slide should appear, press **Set** on that
   row (or type `1:20`). Cues must run forward — the panel flags violations inline.
7. **Present**: fullscreen, music drives the deck. Arrow keys override auto-advance;
   "Following music" hands control back.

### Editing on the canvas

| Gesture | Does |
|---|---|
| Click / Shift+click / Ctrl+click | Select · extend the selection |
| Drag on empty space | Rubber-band; encloses to select. Shift adds to the selection |
| Drag an element | Move it — or the whole selection, rigidly |
| Drag a handle | Resize (single selection only) |
| Drag the round handle above | Rotate; Shift constrains to 15° |
| Hold Alt while dragging | Suspend snapping for that gesture |
| Arrows / Shift+arrows | Nudge 2 units / one grid step |
| Ctrl+A · C · X · V · D | Select all · copy · cut · paste · duplicate |
| Ctrl+Shift+↑ ↓ Home End | Bring forward · send backward · to front · to back |
| Right-click | The full command menu, scoped to what's under the pointer |
| Del / Backspace | Delete the selection (locked elements survive) |

Toolbar carries insert, arrange, align, distribute, grid, snap and zoom. The right rail
switches to a multi-selection panel when more than one thing is picked.

**Focus mode** (`⛶ Focus`, or Ctrl+Shift+F) fills the screen with the editor and drops the
app chrome and the music panel — for building slides when timing isn't the job. The slide
rail, properties sidebar and assistant each toggle from its strip, so it goes as far as
"canvas only". Leaving restores the music panel unless it was reopened inside focus mode.

*Why a flag on `DeckScreen`, not a second component:* forking the editor to make it bigger
is the same mistake as forking `SlideRenderer` to make it present — every future panel
would need adding twice. Present mode *does* replace the editor, because it plays audio
and two live players is a real bug, not a tidiness question.

*Two traps in the Fullscreen API,* both handled once in `useFullscreen`: the request
rejects outside a user gesture (so fullscreen is a bonus, never a precondition — focus
mode still works as an in-page layout if refused), and the user can leave it without
telling React (Esc, F11), which needs a `fullscreenchange` listener. Focus mode watches
for the *transition* out of fullscreen rather than testing "focus && !active", because
`requestFullscreen` is async and the direct test cancels focus mode before it starts.

### Using the assistant

Type an instruction → it proposes a plan → you read it → Apply. The batch lands as **one**
undo step. Plan lines name the slides that *actually resolved*, which is how a misread
target is caught before it happens.

Paste `[Section]`-tagged text to distribute a whole song's content across slides at once,
creating any slide that doesn't exist. Shift+Enter for a newline; Enter sends.

Ask for song details ("add the metadata for *X* to a new first slide") and it searches
Genius itself. If nothing matches confidently it shows the candidates and waits — pick
one, or **None of these**, and it says it couldn't find the song rather than making the
details up.

### Driving it from the CLI

```bash
npm run mcp:build
# register dist-mcp/mcp/server.js with --library <your library folder>
```

Tools: `list_decks`, `read_deck`, `describe_capabilities`, `create_deck`, `apply_ops`
(with `dryRun`), `delete_deck`, `genius_search`, `genius_title_slide`.

Only **real-folder** libraries work — an IndexedDB library lives inside the browser and is
unreachable from a terminal. There is **no undo on disk**; use `dryRun` for large plans.

### Commands

```bash
npm run dev        # vite dev server — the daily loop
npm test           # vitest — 328 tests
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build (refuses to run with a key in .env)
npm run mcp:build  # compile the MCP server to dist-mcp/
```

---

## Hard rules

Break these and the design stops working. Each was argued through, not defaulted to.

0. **Slides live in one 1280×720 space, scaled at the edges.** Never fork `SlideRenderer`
   into a separate "present" renderer; never store screen pixels or percentages.
1. **No `fs`/`path`/`child_process`/Electron outside the adapter layer.** `src/` is
   browser-pure. `mcp/` is the Node counterpart and lives outside `src/` for this reason.
2. **Nothing derived is stored in `song.json`.** Roman numerals, canonical rotations,
   n-grams and edge weights are index data, rebuilt on scan — so changing the matching
   algorithm is a re-index, not a migration.
3. **`section.progression` is the graph's only harmonic input.** `chordChart` blocks are
   *layout*. Never make the graph read blocks.
4. **Rotations are not identical.** `I-V-vi-IV` and `vi-IV-I-V` share a cyclic sequence but
   differ in function and feel. Store the original; derive the canonical rotation at index
   time.
5. **Sections stay sorted and non-overlapping** (`Song.superRefine`); **deck cue times run
   forward** (`Deck.superRefine`). Both exist because the sync engine assumes one active
   item and a forward-running clock.
6. **Schema changes bump the version and ship a migration.** Worked examples: song v1→v2
   added `AudioRef.kind`; deck v1→v2 wrapped `background` into a `color | image` union.
   Every reader runs `migrateSong`/`migrateDeck` *before* validating.
7. **Use `.prefault({})`, never `.default({})`, for a nested object of defaults.** Zod's
   `.default()` stores the literal without parsing, so `TextStyle.default({})` persists a
   bare `{}` and renderers read `undefined` for fontSize. This bit once; `deck.test.ts`
   guards it.
8. **Session state is never deck data.** The stem mixer, the clipboard, zoom, grid and
   snap all live in `deckStore` but outside `deck`. Muting vocals for a rehearsal, or
   zooming to 150%, is not a property of the presentation — storing it would dirty the
   document and eat undo slots for something nobody wants to undo. Same reasoning as the
   graph index: derived or ephemeral things stay out of the saved file. `deckStore.test.ts`
   guards this for the view state.

9. **The agent never authors content.** No lyrics, chords, keys or analysis. It places
   text the user supplied, verbatim — including their typos.

---

## Traps

- **Never read a fresh object through a Zustand selector.** `useStore(s => s.thing())`
  where `thing()` builds a new array/object re-renders forever (Object.is sees a change
  every time) until React bails out and blanks the screen. This shipped once. Compute in
  `useMemo` or a module function instead. Booleans are fine.
- **An inline editor must hide the element it edits.** `SlideCanvas` lays a live textarea
  over the text (or tab) element being edited; the field is only tinted, not opaque, so the
  element's own text rendered underneath and every character appeared twice, offset by the
  field's border. `SlideRenderer` takes `hiddenElementIds` for this. The field also has to
  *match* the renderer — same typography, wrapping and `valign` (hence the exported
  `JUSTIFY` and the content-tracking height), and its ring is an `outline`, not a `border`,
  because a border shifts the text inside it. Any future editable kind inherits this same
  trap and needs the same three things: hide, match, outline.
- **The inline editor's wrapper must grow past the element's saved height, not clip to it.**
  `elementStyle(editing)` fixes `height` to `el.h`, and the wrapper keeps `overflow:
  hidden` so a finished slide doesn't leak text past its box. Applied unmodified while
  *editing*, that combination clips anything past the box's original height to invisible —
  a short default text frame (120 units) showed only its first line or two, with the rest
  of what was typed silently there in state but impossible to see or navigate to. Fixed by
  overriding the wrapper's height to `Math.max(el.h, editorHeight)` — same
  content-tracking measurement `pendingCursor`/auto-height already computes for `valign` —
  so it only grows past the saved size while there's more content than fits, and reverts
  the instant editing ends.
- **Tab elements need the same fix again, on width.** Height alone wasn't enough: a tab
  line never wraps (`white-space: pre` — wrapping would misalign the string grid), so a
  line longer than the box was invisible *and* unreachable by mouse, with no scrollbar to
  reach it either (`overflow: hidden` draws none). Fixed the same way, `editorWidth`
  mirroring `editorHeight`, gated to `editing.kind === "tab"` only — text already handles
  overflow by wrapping within its box, so growing its width too would be wrong, not just
  unnecessary. The measurement itself needs the same collapse-first trick as height
  (`field.style.width = "1px"` before reading `scrollWidth`): without it, `scrollWidth` on
  an already-wide box just reports that same width back once short content no longer
  overflows it, so the box could grow but never shrink back down.
- **Clipping and shrink-to-fit are two different bugs that look identical from a
  screenshot.** Both of the traps above are about the *editing* overlay growing to keep
  content visible while typing. Resizing a box *without* entering edit mode (drag a handle
  on a merely-selected element) never touches that overlay at all — it goes through the
  normal `ElementView` render, which used to just clip via `overflow: hidden` at a fixed
  `fontSize`. `FitText`/`useShrinkToFit` (see idea #1, above) is what fixed *that* one.
  If text looks cut off, check first whether the element is mid-edit (grow-to-fit territory)
  or merely selected/resized (shrink-to-fit territory) — they're fixed in different files.
- **Growing an editing box has a *third* boundary: the slide itself.** Even with both
  traps above fixed, a box positioned low or wide on the slide could still clip — not
  against its own saved size, and not against the wrapper, but against `SlideRenderer`'s
  outer container, which is *always* clipped to exactly 1280×720 (that's what keeps a
  finished slide's content from leaking past its physical edges in the first place). The
  editing overlay lives inside that same clipped container, so growth that crosses
  `SLIDE_H`/`SLIDE_W` doesn't reveal more content — it just moves the clipping boundary
  from "the box" to "the slide", the exact same failure one edge further out.
  Fixed by capping only the **wrapper's** height/width at `SLIDE_H - editing.y` /
  `SLIDE_W - editing.x` (`editorBoxHeight`/`editorBoxWidth` in `SlideCanvas.tsx`) and
  giving the wrapper `overflow: "auto"` — a no-op whenever content already fits, which is
  the common case. **The textarea inside stays at its own natural, uncapped size**
  (`editorHeight`/`editorWidth`, unchanged) rather than being capped or stretched to
  match — that's deliberate, not an oversight, and doing it the other way round is a
  trap in its own right:
  - Capping the *textarea* directly and making it scroll internally was tried first and
    reverted — it broke basic typing (the editor would close on the very next keystroke).
    The exact mechanism was never pinned down, and re-introducing that shape of change
    should come with real reason to believe the regression won't come back, not just a
    plausible-looking refactor.
  - A textarea kept at its *natural* size, taller than a capped wrapper, is what gives
    the wrapper's `overflow: auto` something to scroll — standard nested-scroll-container
    behavior, not exotic.
  - It's also what `valign` depends on: when there's *less* content than the box's own
    saved size, a textarea stretched to fill a taller wrapper would leave `justifyContent`
    nothing to align. Staying at its true (possibly shorter) size is what leaves `valign`
    room to position it top/middle/bottom.
- **A hook inside a kind-branch breaks the rules of hooks.** `ElementView` branches on
  `element.kind` with early returns per kind; a `useLayoutEffect` called only inside the
  `text`/`tab` branches would mean different kinds call a different number of hooks across
  renders, which React disallows. `FitText` exists as a separate component (not inlined)
  specifically so its hook is called unconditionally within its *own* body — nest a
  conditional hook one component down rather than reaching for one inside a branch.
- **Selection-derived lists must be memoised.** `elements.filter(el => selectedIds.includes(el.id))`
  is exactly the fresh-array trap above; `SlideCanvas` and `PropertiesPanel` compute it in
  a `useMemo` or in the render body, never in a selector.
- **Describe a batch against the evolving deck.** `describeOps` folds state between ops;
  describing them all against the starting deck reports "matches nothing" for anything
  depending on an earlier op — telling the user nothing will happen when it will.
- **Auto-advance must yield to the presenter.** `PresentMode` keeps a `manual` flag: once
  an arrow key is pressed the clock stops changing slides until the presenter resumes. A
  teacher answering a question must not have the slide yanked forward.
- **Uncued slides are skipped by the clock, not unreachable** — arrow keys still walk
  them, so a deck can mix timed and untimed material.
- **Duplicating a slide must not copy its cue**, and element ids must be regenerated —
  duplicate cues break the forward rule; duplicate element ids break selection.
- **Concurrent deck writes need serializing.** MCP clients may call tools in parallel;
  without a per-deck lock two edits lose one update *and* can corrupt the file.
- **`restore()` vs `attach()`.** Chromium persists directory handles but drops the
  permission grant, so `restore()` often returns false. The "open library" button must
  exist on the load path — `attach()` outside a user gesture throws.
- **`section.key` matters more than it looks** (song-study). A wrong key silently poisons
  every graph edge derived from that section.
- **Don't put `currentTime` in React state**, and don't use `timeupdate` (see the stack
  table).

---

## Secrets

`.env` holds `VITE_OPENAI_API_KEY` (assistant) and `GENIUS_ACCESS_TOKEN` (MCP metadata).

**Vite inlines `VITE_*` at build time**, so that key becomes a literal in `dist/`. Fine
locally — this app is built to run on your own machine — but it means a browser can never
hold a secret. Obfuscation doesn't help: the code that unwraps it also ships. The only
real fixes are each user supplying their own key, or a server holding it.

`npm run build` therefore **refuses to run** while a real key is in `.env`, since a
warning would scroll past unnoticed. Escape hatch: `ALLOW_BUNDLED_KEY=1 npm run build`.

`GENIUS_ACCESS_TOKEN` is deliberately **not** `VITE_`-prefixed — Node reads it directly,
so it never reaches the browser bundle.

---

## Lyrics

Recurring request; settled here.

The **Genius API returns metadata only** — title, artist, album, release date, artwork.
It has no lyrics endpoint, because Genius licenses lyric text from publishers and holds no
redistribution rights. Libraries that appear to fetch lyrics from Genius use the API only
to find a song's page URL and then scrape the HTML, which is outside the API and against
its terms. `mcp/genius.ts` says this at the top: **do not add scraping there.**

Legitimate routes: a licensed provider (Musixmatch, LyricFind — commercial terms, free
tiers return partial text), or the user pasting text they hold rights to. The latter is
built: `[Section]`-tagged paste distributes content across slides.

---

## File map

```
src/
├── schema/
│   ├── deck.ts       ★ THE DOCUMENT. Deck, Slide, SlideElement (text|image|shape|tab),
│   │                   Background (color|image), Theme, cue helpers
│   │                   (buildCues/slideIndexAt/formatCue/parseCue), migrateDeck.
│   ├── song.ts       song-study document + migrateSong
│   └── blocks.ts     song-study slide blocks
├── deck/
│   ├── templates.ts  LAYOUTS (placeholder generators), THEME_PRESETS, applyLayout()
│   ├── geometry.ts   ★ editing maths: snapping, marquee enclosure, bounds, align
│   └── bundle.ts     .zip export/import of a deck and its media
├── agent/            the assistant — one vocabulary, several producers
│   ├── ops.ts        ★ THE CONTRACT: Op + Target unions
│   ├── targets.ts    resolveTarget() — "verses 1 2 3" → slide indexes
│   ├── apply.ts      applyOps() pure batch transform; validateOps() dry run
│   ├── describe.ts   describeOp/describeOps — preview text, folds state forward
│   ├── prompt.ts     system prompt (the toolbook) + JSON Schema for models
│   ├── parse/        sections.ts (vocabulary) · grammar.ts (the parser)
│   └── providers/    deterministic · openaiCompatible (.env or ⚙) · codexCli (desktop)
├── adapters/         the only place the platform may leak in
│   ├── types.ts · paths.ts · browser.ts · indexeddb.ts
│   └── index.ts      sharedLibraryAdapter() — ONE instance; attachment is
│                     per-instance state, so two would disagree about being open
├── store/            deckStore ★ · agentStore · playerStore · libraryStore · graphStore
├── components/       DeckLibraryScreen · DeckScreen · deck/{SlideRenderer ★,
│                     SlideCanvas ★, CanvasContextMenu, SlidePanel, EditorToolbar,
│                     PropertiesPanel, TimingPanel ★, PresentMode ★, AgentPanel,
│                     AgentSettings, BackgroundEditor, StemMixer, SeparateStems,
│                     useDeckAssets, useFullscreen} · (song-study screens)
├── theory/ graph/    song-study: roman numerals, Booth's rotation, n-grams, edges
└── types/            ambient .d.ts only (Vite env)

mcp/                  Node-only. Outside src/ so hard rule #1 holds.
├── library.ts        fs deck I/O — atomic writes, per-deck write serialization
├── genius.ts         Genius METADATA client (no lyrics; see above)
└── server.ts         stdio server; apply_ops takes the same Op vocabulary
```

### On disk

```
<library-root>/
├── decks/<uuid>/     deck.json · audio.mp3 · assets/
└── songs/<uuid>/     song.json · audio.mp3 · assets/ · .cache/peaks.json
```

The IndexedDB adapter emulates this with key prefixes across separate object stores — one
database *per store*, because idb-keyval only creates an object store during a database's
first open.

---

## Roadmap

Done: deck schema · layouts/themes · canvas editing · undo/redo · image & colour
backgrounds · MP3 cues · fullscreen present · assistant (parser + model + MCP) · Genius
metadata · song-study mode with theory engine and harmonic graph.

Next, roughly in order:

1. **Presenter view** — speaker notes + next-slide preview on a second screen.
   `slide.notes` already exists and is editable; nothing displays it.
2. **ODF export, then import** — `.odp` is a ZIP of XML. Export first (we control the
   shape); import is much harder.
3. **PDF export** — probably a print stylesheet over `SlideRenderer`.
4. **Electron** — second `LibraryAdapter`, `runCodex` for the Codex provider, and a
   `better-sqlite3` graph index.

Deferred, don't build early: slide transitions and per-element animation, collaborative
editing, video elements, rich per-word text styling, pitch shift, metronome, staff
notation.
