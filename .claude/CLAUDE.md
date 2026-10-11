# songs-teacher

## What this is

**A presentation editor for music teachers.** The app is a slide editor in the mould of
LibreOffice Impress — slide rail, canvas, properties sidebar, layouts, themes — plus one
thing Impress has no equivalent for: you attach a song and cue each slide to a timestamp
in it. Press Present and the track plays while the deck follows along, so a "song
presentation" (intro at 0:00, verse 1 at 1:20, chorus at 2:22) runs itself while the
teacher talks over it.

Everything is authored by hand. There is no assistant, no generation pipeline, no MCP
server and no model-driven editing — all of those were removed. Stem separation remains:
it is local signal processing (an ONNX model run in the browser), not an assistant.

Secondary and older: a song-study mode for marking sections of a track and writing
harmonic analysis, plus a knowledge graph linking songs by shared harmony. Still works,
reachable from the start screen, no longer what the app is for.

### Product direction

The native React/TypeScript editor is the sole editing path. The experimental
LibreOfficeKit integration is retired. Do not reintroduce a LibreOffice runtime,
C++ host, headless converter or parallel editor. Do not reintroduce an assistant,
pipeline or other AI-driven feature unless the user asks for it.

### About the name

`songs_teacher` is the project name — the folder, and the remote at
`github.com/nirlaniado/songs_teacher`. It was `libre_off` until renamed; the app owns its
document model, renderer, editor and playback engine, and never required a LibreOffice
runtime, so the old name had stopped describing anything. Future format support must not
require the retired LibreOffice core integration.

**The string `libre-off` deliberately survives in four places, and renaming it is a data
migration, not a rename.** Do not "tidy" these:

- `src/adapters/indexeddb.ts` — five IndexedDB **database names**. Renaming them doesn't move
  anybody's data; it opens five new empty databases and leaves every saved deck and song
  unreachable on disk.
- `src/adapters/browser.ts` — the handle store's database name, and the File System Access
  picker `id` that remembers which folder the user last opened.
- `src/audio/separate.ts` — `CACHE_NAME`, the Cache API bucket holding the **~172MB** ONNX
  model. A new name means every user re-downloads it.
- `src/deck/bundle.ts` — `MANIFEST` and the `app` field written inside exported `.zip`
  bundles, and checked on import. A new value makes every previously exported deck fail to
  import.

Changing any of them needs a migration shipped alongside (hard rule 6's reasoning applies:
a reader must handle what was already written). Nothing user-visible depends on these
strings, so the cost has no matching benefit.

---

## Architecture

Five load-bearing ideas. Everything else is detail.

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

### 3. One player interface, two engines

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

### 4. The adapter boundary

`LibraryAdapter` (`src/adapters/types.ts`) is the entire platform surface. Everything
above it is plain browser code.

*Why:* it keeps `vite dev` in a browser as the daily loop with real HMR, and turns
"ship on Electron" into a second implementation of one file rather than a port.

**Rule: no `fs`, `path`, `child_process` or Electron imports outside the adapter layer.**
Want the filesystem? Add a method to `LibraryAdapter`.

### 5. The editing surface is a selection plus commands over it

`selectedElementIds: string[]` in `deckStore` is the single source of truth for what is
picked. Every editing command — align, arrange, distribute, clipboard, nudge, delete —
reads that array and commits **one** `Deck -> Deck` transform, so a gesture is one undo
step regardless of how many elements it touched.

*Why an array and not an id:* align, distribute and "delete these three" are meaningless
on one element. A single-selection UI would have to be widened the moment any of them
arrived, so the store holds the general case from the start.

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
- **`+ Tab ▾` opens a tuning picker and seeds a labelled scaffold, not an empty box.**
  `TUNING_PRESETS` and `tabScaffold()` live in `deck/templates.ts`, next to
  `THEME_PRESETS` — same status: static reference data the user picks from, not
  inference. Covers Standard, Half step down/up, Drop D, Drop C, Drop C#, each as a
  fixed high-to-low string list (`tuningById`, defaulting to Standard for an unknown
  id). This is a UI convenience: `e|-------` carries no
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
| Validation | **Zod** | Schema and TS types from one definition. Runtime cost on parse; buys a single source of truth that the app and the tests share. |
| State | **Zustand** | Not Redux (ceremony) or Context (re-render storms). Selector-based subscription is what keeps a 60fps clock out of the render tree. |
| Playback clock | **`requestAnimationFrame`** | Not the `timeupdate` event, which fires ~4×/sec — a slide cued to a downbeat would visibly arrive late. |
| Desktop (planned) | **Electron**, not Tauri | Tauri's OS webview means codec support varies per platform — unacceptable for an audio app. Electron bundles Chromium; costs bundle size. |
| Browser storage | **File System Access API**, IndexedDB fallback | Real files where possible. IndexedDB keeps Firefox/Safari working but has no folder to back up and dies with site data. Not a strict upgrade — surfaced in the UI, not hidden. |
| Graph index | **In-memory**, not SQLite | `better-sqlite3` is a native module that cannot load in a browser tab. Same `{nodes, edges}` shape, rebuilt on demand; swappable in the Electron phase. |
| Multi-track sync | **Web Audio buffers**, not `<audio>` elements | Media elements each run their own clock and drift within seconds. Buffer sources started against one context clock are sample-accurate. Costs memory (~85MB per decoded 4-min stem) and one-shot nodes that must be rebuilt to seek. |
| Stem separation | **In-browser ONNX** (`demucs-web` + `onnxruntime-web`) | Not a Python/Node service: self-contained, nothing to install, nothing uploaded. Costs a ~172MB model download (cached) and minutes of CPU per song. Needs COOP/COEP for `SharedArrayBuffer`. |
| Separation library | **`demucs-web`**, not hand-ported inference | It owns STFT (4096/1024), reflect padding, segmentation and overlap-add — all easy to get subtly wrong. Costs: it hardcodes four sources, so a guitar stem isn't available. |
| Stem storage | **WAV** | Trivial to encode with no dependency; the browser has no non-realtime MP3/Opus encoder. Costs ~10MB per stem-minute on disk. |
| Isolation policy | **COEP `credentialless`**, not `require-corp` | `require-corp` blocks cross-origin subresources that don't opt in, which would break fetching the model from Hugging Face. |
| Lyrics | **From the user's own Ultimate Guitar chart, or typed** | No lyrics *provider* is integrated (Musixmatch/LyricFind need commercial terms; lyric sites are off-limits). The chord agent keeps the lyrics on the chart the user's own subscribed account opens, and they are used on slides and to time the deck. |

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
rail, properties sidebar and music panel each toggle from its strip, so it goes as far as
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

### Commands

```bash
npm run dev        # vite dev server — the daily loop
npm test           # vitest — 277 tests
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```

---

## Hard rules

Break these and the design stops working. Each was argued through, not defaulted to.

0. **Slides live in one 1280×720 space, scaled at the edges.** Never fork `SlideRenderer`
   into a separate "present" renderer; never store screen pixels or percentages.
1. **No `fs`/`path`/`child_process`/Electron outside the adapter layer.** `src/` is
   browser-pure.
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
- **Auto-advance must yield to the presenter.** `PresentMode` keeps a `manual` flag: once
  an arrow key is pressed the clock stops changing slides until the presenter resumes. A
  teacher answering a question must not have the slide yanked forward.
- **Uncued slides are skipped by the clock, not unreachable** — arrow keys still walk
  them, so a deck can mix timed and untimed material.
- **Duplicating a slide must not copy its cue**, and element ids must be regenerated —
  duplicate cues break the forward rule; duplicate element ids break selection.
- **`restore()` vs `attach()`.** Chromium persists directory handles but drops the
  permission grant, so `restore()` often returns false. The "open library" button must
  exist on the load path — `attach()` outside a user gesture throws.
- **`section.key` matters more than it looks** (song-study). A wrong key silently poisons
  every graph edge derived from that section.
- **Don't put `currentTime` in React state**, and don't use `timeupdate` (see the stack
  table).

---

## Lyrics

Revisited by the user; the earlier "no lyrics at all" rule is replaced. Lyrics come from exactly
two places: text the user types or pastes, and the lyric lines on the Ultimate Guitar chart that
the chord agent opens with the user's own subscribed account (`ChordLine.row`/`lyric`,
`server/ug/core.ts` `parseChordContent`). No lyric provider or lyric site is integrated —
Musixmatch/LyricFind need commercial terms and scraping lyric sites breaks theirs; don't add one.

What the lyrics are for: they appear under the chords on generated slides, and they time the deck.
`createDeckFromChords` sends the MP3 (audio only) to OpenAI via the local service for a
timestamped transcript (`server/ug/transcribe.ts`, `POST /api/ug/transcribe`), then
`audio/lyricSync.ts` matches each section's lyrics to the transcript **in the browser** — the
chart's lyrics are never sent anywhere. `audio/segment.ts` `planFromMatches` turns matches into
cues and `planCues` is the music-only fallback. A deck does not store lyrics separately (they are
in the slides' text), so **Auto-suggest cues** in the Music sync panel re-times from the music
alone.

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
├── adapters/         the only place the platform may leak in
│   ├── types.ts · paths.ts · browser.ts · indexeddb.ts
│   └── index.ts      sharedLibraryAdapter() — ONE instance; attachment is
│                     per-instance state, so two would disagree about being open
├── store/            deckStore ★ · playerStore · libraryStore · graphStore
├── components/       DeckLibraryScreen · DeckScreen · deck/{SlideRenderer ★,
│                     SlideCanvas ★, CanvasContextMenu, SlidePanel, EditorToolbar,
│                     PropertiesPanel, TimingPanel ★, PresentMode ★,
│                     BackgroundEditor, StemMixer, SeparateStems,
│                     useDeckAssets, useFullscreen} · (song-study screens)
├── theory/ graph/    song-study: roman numerals, Booth's rotation, n-grams, edges
└── types/            ambient .d.ts only (Vite env)
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

First: make the native editor usable and reliable end to end. Existing foundations
include layouts/themes, canvas editing, undo/redo, backgrounds, music cues, stems,
fullscreen presentation and song-study tools.

Potential editor improvements include presenter view, richer text, grouping and native
format export/import. Set detailed priorities with the user as that work begins.
LibreOffice integration is retired.

---

## Agent team

Development runs as a small agent team inside Herdr. The user does **all** devops: they own the
remote, merges, CI secrets, tokens and releases. Agents only ever produce reviewed branches.

| Seat | Model | Role |
|---|---|---|
| `pm` | Opus 5 | Board, briefs, dispatch, acceptance, PRs. Writes no production code. |
| `dev` | Opus 5 (Sonnet 5 for mechanical tasks) | Implements one task at a time in its own worktree. |
| `review` | codex / GPT-5.6-Sol | Read-only audit of the diff. Different model family on purpose. |

Each seat's standing prompt is a committed file in `.herdr/seats/`. **Only `pm` may write there** —
a seat cannot edit its own constraints, and because every change reaches the default branch
through a PR the user merges, the gate enforces that even if the instruction is ignored.

**Isolation:** the worktree is a seat's permanent desk (`node_modules` stays installed, cwd never
moves); the branch is the disposable task (`feat/<issue-number>`, one atomic merge each). Only `pm`
touches the default-branch checkout. A fresh worktree needs its own `npm install` —
`node_modules` is gitignored and not shared.

**Board:** GitHub Issues, single source of truth. The brief lives in the issue body; issues
labelled `devops` are assigned to the user.

**Gate order, cheapest first** — the reviewer is the second most expensive gate and the user is
the most expensive:

1. `npm test` + `npm run typecheck` locally in the worktree
2. push `feat/<n>` → `ci.yml` proves it on a clean machine (this is the only gate that catches a
   new file the implementer forgot to `git add`)
3. green → `review` audits the diff, with CI's result as evidence
4. sign-off → `pm` opens the PR → `main.yml` runs on it → the user merges

**Hub and spoke:** seats never prompt each other. Every handoff routes through `pm`. An
agent-to-agent chain has no supervisor and can deadlock with nothing on screen.

**Escalation:** `pm` decides naming, style, test placement and scope trims. The user decides a
`CLAUDE.md` hard-rule dispute, any schema/migration or architectural change, anything
security-touching, and any `dev`/`review` disagreement still live after one exchange. A `blocked`
agent raises a desktop notification and waits — `pm` never answers an approval for the user.

**Concurrency:** one `dev` seat; a second only once the merge queue clears comfortably; hard cap
of two. The user is the only merger, so extra branches lengthen their queue rather than shipping
more.
