# ARCHITECTURE_AUDIT.md

**Phase 0 deliverable — no implementation code.**
Working codename: **MPW** (Music Presentation Workstation). Placeholder; see §42 of the brief.

---

## 0. Confidence and provenance

This audit separates what was **verified during this session** from what is **stated from
knowledge of the codebase and needs confirming against a real checkout**. That distinction is
load-bearing: a plan built on unverified class names fails on contact.

| Claim | Status |
|---|---|
| LibreOfficeKit C API surface (functions/signatures) | **Verified** — read from `include/LibreOfficeKit/LibreOfficeKit.h` on master |
| Collabora Online process architecture (wsd/forkit/kit, WebSocket + tiles) | **Verified** — vendor + DeepWiki docs |
| LibreOffice license = MPL-2.0, contributions dual MPL-2.0/LGPLv3+ | **Verified** — documentfoundation.org |
| "LibreOffice" name/logo are registered trademarks | **Verified** |
| Build cost ≈ 15–25 GB disk, ~5 h on 16 GB/8-core | **Verified** — BLFS + community reports |
| `libreofficekit-dev` available prebuilt in Ubuntu 24.04 | **Verified** — `apt-cache policy` on this machine |
| Module-level responsibilities of `sd/`, `svx/`, `sfx2/`, `vcl/` | **High confidence**, module level |
| Specific C++ class names inside `sd/` | **NOT verified** — see §1.6 for exact commands |

**Nothing below depends on an unverified class name.** The design deliberately sits on the
LOK C API, which was read directly, precisely so that internal class churn cannot break it.

---

## 1. LibreOffice Source Map

### 1.1 Presentation core

| Directory | Responsibility | Our disposition |
|---|---|---|
| `sd/` | Impress **and** Draw. Document model (`SdDrawDocument`), page/slide model (`SdPage`), views, the Impress UI shell, outline/slide-sorter/notes views, `.uno:` command handlers. The primary presentation subsystem. | **Reuse unchanged, drive via LOK.** Do not fork. |
| `slideshow/` | Slideshow *playback* engine: transitions, per-shape animation, timing, the presentation-mode renderer. | **Reuse.** Not the sync clock — see §3.5. |
| `svx/` | Drawing layer shared by all apps: `SdrObject` shape hierarchy, `SdrModel`, media objects, the drawing UI widgets. `sd/` is deeply dependent on it. | **Reuse unchanged.** Never fork — this is a main artery. |
| `editeng/` | Rich text editing engine used inside shapes/text frames. | **Reuse unchanged.** |
| `oox/` | OOXML (`.pptx`) import/export filters. | **Reuse unchanged.** This is a large part of the value. |
| `sfx2/` | Application/document framework: `SfxObjectShell`, `SfxViewShell`, the `.uno:` dispatch mechanism, undo manager integration. | **Reuse.** We call into dispatch via LOK, not by subclassing. |
| `framework/` | UI configuration: menus, toolbars, command → UNO wiring. | **Mostly bypass** — our UI is not VCL. Relevant only for `.uno:` name resolution. |
| `vcl/` | Widget toolkit + rendering backends (gtk3, headless/`svp`). | **Reuse the headless backend only.** Do not build a VCL UI. |

### 1.2 Media / audio

| Directory | Responsibility | Our disposition |
|---|---|---|
| `avmedia/` | LibreOffice's media abstraction (GStreamer on Linux). Backs the media shape in Impress. | **Avoid for our audio engine.** See §3.5 — reasoning is important. |

**Why we do not use `avmedia` for the music engine.** `avmedia` exists to play a media object
*embedded in a document*, under the document's control. Our requirement (brief §23) is the
inverse: one master transport that drives slides, timeline, tablature and chords, and stays
sample-accurate under seek. Routing that through `avmedia` would put LibreOffice's document
lifecycle between us and the clock, and would tie our transport to GStreamer's state machine.
Audio is our own subsystem, outside LibreOffice. `avmedia` remains available for the ordinary
"video embedded in a slide" case, which it does well.

### 1.3 LibreOfficeKit — the integration boundary

| Path | Contents |
|---|---|
| `include/LibreOfficeKit/` | The public C API (`LibreOfficeKit.h`, `LibreOfficeKitEnums.h`). **This is our contract.** |
| `desktop/source/lib/init.cxx` | The LOK implementation — where UNO/`sd` is bridged to the C API. The file to read if something is missing. |
| `libreofficekit/` | Helper library + `gtktiledviewer` reference client. Useful as a worked example, not a dependency. |

**Verified LOK surface relevant to us** (signatures read from master):

```c
// Slides are "parts". This is the single most important fact for this project.
int   (*getParts)     (LibreOfficeKitDocument*);
void  (*setPart)      (LibreOfficeKitDocument*, int nPart);
char* (*getPartName)  (LibreOfficeKitDocument*, int nPart);
char* (*getPartInfo)  (LibreOfficeKitDocument*, int nPart);

// Render a specific slide into an RGBA buffer we own.
void  (*paintPartTile)(LibreOfficeKitDocument*, unsigned char* pBuffer,
                       const int nPart, const int nMode,
                       const int nCanvasWidth, const int nCanvasHeight, ...);

// Editing: raw input, and the command layer.
void  (*postMouseEvent)(LibreOfficeKitDocument*, int nType, int nX, int nY,
                        int nCount, int nButtons, int nModifier);
void  (*postKeyEvent)  (LibreOfficeKitDocument*, int nType, int nCharCode, int nKeyCode);
void  (*postUnoCommand)(LibreOfficeKitDocument*, const char* pCommand,
                        const char* pArguments, bool bNotifyWhenFinished);

// Persistence and export, format-driven.
int   (*saveAs)        (LibreOfficeKitDocument*, const char* pUrl,
                        const char* pFormat, const char* pFilterOptions);

// Change notification back to us.
void  (*registerCallback)(LibreOfficeKitDocument*, LibreOfficeKitCallback, void*);
```

Three consequences worth stating plainly:

1. **Slides map to LOK "parts".** Add/delete/reorder/duplicate slide, and rendering a specific
   slide, are all reachable without touching `sd/` source.
2. **`postUnoCommand` *is* the command API the brief asks for in §26.** LibreOffice already has
   a stable, named, string-addressable command vocabulary (`.uno:InsertPage`,
   `.uno:DuplicatePage`, `.uno:DeletePage`, …). We do not invent a presentation command layer —
   we wrap an existing one and add our own commands beside it. This is a large saving and it is
   exactly the AI-agent-callable surface §27 requires.
3. **`saveAs(url, format, options)`** covers ODP, PPTX and PDF export from one call. Format
   support is a filter string, not code we write.

### 1.4 Explicitly out of scope

`sw/` (Writer), `sc/` (Calc), `dbaccess/`/`connectivity/` (Base), `starmath/`, `reportdesign/`,
`extensions/`. We neither fork nor build these where avoidable.

### 1.5 What *cannot* be extracted

`sd/` is not separable. It depends on `svx` → `editeng` → `sfx2` → `vcl` → `tools`/`comphelper`/
`cppuhelper`/`sal`, wired through UNO. There is no "presentation module" to lift out. This was
the correct conclusion in the previous project and it remains correct — **but it argues for
consuming LibreOffice whole via LOK, not for abandoning LibreOffice.** That is the pivot this
audit makes.

### 1.6 Verification commands (run against a real checkout)

```bash
git clone --depth 1 https://git.libreoffice.org/core libreoffice-core
cd libreoffice-core
ls sd/source/ui/           # Impress UI shells
ls sd/source/core/         # SdDrawDocument, SdPage
ls slideshow/source/engine # transition/animation engine
sed -n '1,200p' include/LibreOfficeKit/LibreOfficeKit.h
grep -rn "getParts\|paintPartTile" desktop/source/lib/init.cxx | head
grep -rn "\.uno:InsertPage\|\.uno:DuplicatePage" sd/ | head
```

---

## 2. Reuse Plan

| Disposition | Components | Rationale |
|---|---|---|
| **Use unchanged** | `sd/`, `slideshow/`, `svx/`, `editeng/`, `oox/`, `sfx2/`, `vcl` (headless), all import/export filters | Reached through LOK. Zero source changes ⇒ zero rebase burden, zero added MPL obligations. |
| **Wrap** | LibreOfficeKit C API | A thin C++/Rust/Go host process exposing a JSON command + event protocol. **All LibreOffice contact is confined to this one component.** |
| **Modify (only if forced)** | `desktop/source/lib/init.cxx` — if LOK lacks something we need | As a *patch series*, never a fork. See §5. |
| **Replace / build new** | Timeline, transport clock, audio, waveform, sections, markers, beat grid, tablature, chords, scales, project format, web UI | No LibreOffice equivalent exists. Pure new code, our license, no coupling. |
| **Avoid** | `avmedia` for the master clock; `framework/` menus; VCL widgets; Writer/Calc/Base | §1.2, §3. |

**Rule this enforces (brief §50 R2):** music/timeline/guitar code contains **zero** LibreOffice
types. It talks to the wrapper's JSON protocol. That single constraint is what keeps the
upstream relationship maintainable.

---

## 3. Architecture Decision (ADR-001)

### 3.1 The options as posed

| | Option | Verdict |
|---|---|---|
| **A** | Native Impress UI in a GUI container (X/VNC/RDP) | **Rejected** |
| **B** | LibreOffice engine + our web UI | **Basis of the choice** |
| **C** | Fork LibreOffice Online / Collabora Online | **Rejected as a fork; adopted as a pattern** |
| **D** | Hybrid | **CHOSEN** |

### 3.2 Why A is rejected

Technically possible — `vcl` has gtk3 and headless backends, and Impress-in-a-container over
VNC is a known trick. It fails on the two things this product actually is:

- **The timeline cannot be added.** A DAW timeline docked under the canvas, with waveform,
  beat grid and draggable slide markers, would have to be built as VCL widgets inside `sd/`'s
  view hierarchy — precisely the "music logic scattered inside Impress code" the brief forbids
  in §3. Guitar Pro panels compound it.
- **Interaction latency.** Remote-framebuffer round-trips are tolerable for typing and
  unacceptable for dragging a slide marker against a waveform at millisecond precision.

Also: no path to the browser deployment §4 requires, and every future AI surface would have to
be retrofitted rather than designed in.

### 3.3 Why C is rejected as a fork

Collabora Online is the **correct reference architecture** and we should copy its shape. But
forking it means inheriting ~200k LOC of WSD, proxy, collaborative-editing, WOPI storage
integration and multi-user session management — none of which V1 needs (no collaborative
editing, brief §49) — plus the obligation to track *two* fast-moving upstreams.

We take its **process model** and leave its codebase.

### 3.4 The decision — Option D, concretely

```
Browser (TypeScript / React)
  │  WebSocket: JSON commands + events, binary slide images
  ▼
MPW Server  ── our code, one process
  │  ├── Command Bus  (the §26 API; also the future AI surface)
  │  ├── Project Model (project.json — schema-versioned)
  │  ├── Transport     (THE master clock)
  │  ├── Timeline / Sections / Markers / Beats
  │  ├── Guitar        (tablature, chords, scales)
  │  └── Audio         (decode, waveform, playback position)
  │
  │  LOK C API  ── the only LibreOffice contact point
  ▼
Kit Process (LibreOffice, headless)  ── unmodified upstream
  └── sd/ · slideshow/ · svx/ · oox/ · filters
```

**Process model, borrowed from Collabora:** one LibreOffice Kit process per open document,
supervised by our server. LOK is not designed for many documents in one process, and a
document crash must not take the server down. This is a verified-in-production pattern, and
adopting it early is far cheaper than retrofitting it.

### 3.5 The master clock — the one decision that cannot be got wrong

The brief's §23 is correct and non-negotiable. **The transport lives in our server, not in
LibreOffice and not in the browser.**

- **Not LibreOffice's**, because `slideshow/`'s timing engine is built to run a self-contained
  presentation, not to be slaved to an external audio position.
- **Not the browser's**, because `<audio>`/`AudioContext` clocks drift, and a seek must
  atomically reposition slides, tablature and chords together.

Everything else — slide switching, playhead, tab cursor, chord highlight — is a **subscriber**.
Seek is one operation on one clock, then a broadcast.

*(Prior art worth reusing: the existing React app already learned this lesson the hard way —
two independent `<audio>` clocks drifted within seconds, and the fix was exactly this
single-owner pattern. See §7.)*

### 3.6 V1 rendering simplification — skip tiles

Collabora implements a full tile cache with invalidation because a Writer document is
effectively unbounded. **A slide is not.** It is one bounded 1280×720-ish rectangle.

For V1: render whole slides via `paintPartTile` into a PNG/WebP, push over the WebSocket,
re-render the affected slide on change. This removes an entire tile-protocol subsystem from V1
while keeping the door open — tiling can be added later behind the same interface if zoom
performance demands it.

### 3.7 Consequences for Docker

Positive: headless `vcl` needs no X server; the container is a normal Linux service exposing
one HTTP/WS port; state is a mounted volume.

Costs, stated honestly: the image carries a full LibreOffice (**~1–2 GB**), cold start of a Kit
process is **~1–3 s**, and each open document costs a process (~150–400 MB RSS). All acceptable
for a self-hosted home-lab tool; all would be problems for a high-density SaaS. That matches
the stated deployment target.

---

## 4. Proposed Repository Structure

Deliberately **not** the brief's `libreoffice-core/` in-tree fork — see §5.

```
mpw/
├── docs/                     ARCHITECTURE_AUDIT.md · LICENSING.md · BUILD.md
│                             DEPENDENCY_MAP.md · ROADMAP.md · adr/
├── server/                   our single service
│   ├── lok/                  ONLY component that includes LibreOfficeKit.h
│   │   ├── kit_process.*     spawn/supervise/restart a Kit
│   │   ├── document.*        load, getParts, paintPartTile, saveAs
│   │   └── uno_commands.*    typed wrappers over .uno: names
│   ├── commands/             the §26 command bus (UI == AI == HTTP surface)
│   ├── project/              project.json model, schema versions, migrations
│   ├── transport/            THE master clock
│   ├── timeline/             tracks, sections, markers, slide-sync, snapping
│   ├── music/                decode, waveform cache, tempo/beat grid
│   ├── guitar/               tablature model, chords, scales, tunings
│   └── api/                  WebSocket + HTTP transport (thin; no logic)
├── frontend/                 TypeScript + React
│   ├── canvas/               slide image + input forwarding
│   ├── timeline/             waveform, tracks, markers, playhead
│   ├── guitar/               tab editor, fretboard, chord panel
│   └── shell/                panels, menus, shortcuts
├── services/                 optional Python/FastAPI (analysis only)
├── shared/                   JSON Schemas — single source of truth for both sides
├── patches/                  quilt-style patches against upstream, if ever needed
├── docker/
└── tests/
```

**`shared/` is not decoration.** Command and project schemas are generated into both TypeScript
types and server-side validators from one definition, so the UI, the HTTP API and a future AI
agent cannot drift apart.

---

## 5. Fork strategy — the biggest maintenance decision

**Do not vendor LibreOffice source into this repository.**

| Approach | Cost |
|---|---|
| Hard fork 10M LOC in-tree | Own every CVE and every rebase, forever. Realistically unmaintainable by a small team. |
| **Consume prebuilt LOK + optional patch series** ← chosen | Track a version. Carry patches only if a real gap appears. |

Concretely:
- **V1 depends on `libreofficekit-dev` as a package**, pinned to a version.
- If LOK genuinely lacks something, add a **patch** in `patches/`, upstream it, and drop the
  patch when it lands. Patches are reviewable; a fork is not.
- Only if patches exceed roughly a dozen files does a maintained fork become justified — and
  that is a decision to revisit with evidence, not up front.

This also **minimises MPL-2.0 obligations**: MPL is file-level copyleft, so unmodified upstream
files carry no new duty on us, and our new files stay under our chosen licence. See LICENSING.md.

---

## 6. Major Technical Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **LOK's Impress surface is thinner than assumed** — some editing operations may not be reachable via `.uno:` | **High** | Phase-0 PoC probes exactly this before any commitment. Fallback: patch `init.cxx` (§5). |
| R2 | **Slide edit → re-render latency feels sluggish** vs. native | High | Whole-slide render (§3.6); measure in PoC; optimise only if measured. |
| R3 | **Build machine is 4 cores / 11 GB** — a source build is ~8–12 h with real OOM risk when linking | **High (today)** | Do not build from source for V1. Use the distro package. Reserve source builds for CI/a bigger box. |
| R4 | Kit process crash loses user work | Medium | Supervise + restart; autosave the project sidecar independently of the ODP. |
| R5 | Container image ~1–2 GB | Medium | Accepted; multi-stage build, no language packs, no Writer/Calc where separable. |
| R6 | Upstream LOK API drift | Medium | Pin version; confine all contact to `server/lok/`; contract tests. |
| R7 | Tablature/timeline scope creep into a DAW/Guitar Pro clone | **Medium–High** | Brief §49 non-goals are the guard. Revisit at each version boundary. |
| R8 | Audio/slide sync drift | Medium | Single master clock (§3.5) — architectural, not a bug fix. |
| R9 | WSL2 filesystem + audio quirks during development | Low–Medium | Develop against the container, not the host. |

**R1 and R3 are the two that could invalidate the plan**, and both are answered in Phase 0
before significant code is written. That is the point of the PoC ordering in ROADMAP.md.

---

## 7. Strategic asset: the existing React application

`/home/nir20/libre_off` (now committed to git, tagged as the pre-pivot baseline) is **not
throwaway work**. It is a working implementation of much of the *music* half of this brief:

| Existing | Maps to |
|---|---|
| Slide-cue timing model, forward-ordering invariant | §11 manual slide time steps |
| Waveform + transport + single-owner rAF clock | §13, §14, §23 |
| Stem separation and mixer (mute/solo/gain) | §30 future stems |
| Tab notation: tunings, scaffolds, bend palette | §18–§20 guitar workspace |
| Chord text placement | §21 chords |
| `src/agent/ops.ts` — Zod-validated op vocabulary, one contract, several producers | **§26 command architecture, essentially as specified** |
| MCP server driving the same op vocabulary | §27/§28 agent + API boundary |

`ops.ts` in particular already embodies the brief's §26 principle (UI and agent share one typed
command contract). **Recommendation: port the frontend and the command-vocabulary design
forward; replace only the document model, which is what LibreOffice now provides.** This
converts the pivot from "start over" into "swap the document engine", and is the single
largest schedule saving available.

---

## 8. The honest trade-off

Stated once, plainly, because it is the decision the rest of the money rides on.

**What adopting LibreOffice buys:** real `.pptx`/`.odp` fidelity (import *and* export), a
mature shape/text/animation model, PDF export, transitions, and decades of filter edge cases —
none of which are realistically reimplementable.

**What it costs:** a ~1–2 GB container, a C++ integration layer, a per-document process model,
LOK as a hard dependency, and a materially longer path to the first usable build than
continuing the pure-TypeScript app.

**Assessment:** if PPTX/ODP interoperability is a real product requirement, this is the right
architecture and Option D is the right shape of it. If it is not, the existing React app is a
faster route to the same music features. The brief states the requirement explicitly (§9), so
this audit proceeds on that basis — while §7 above preserves the existing investment rather
than discarding it.

---

## 9. Decision requested

Proceeding past Phase 0 needs sign-off on:

1. **ADR-001 — Option D** (LOK engine + our server + web UI), §3.
2. **No in-tree LibreOffice fork**; distro package + optional patch series, §5.
3. **Whole-slide rendering in V1**, tiles deferred, §3.6.
4. **Port the existing React frontend and `ops.ts` command design forward**, §7.
5. **Product name** — `mpw` is a placeholder and affects package/repo/container naming.

Per the brief's closing instruction, no structural work proceeds until these are approved.
