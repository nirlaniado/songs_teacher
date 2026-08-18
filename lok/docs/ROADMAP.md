# ROADMAP.md

**Phase 0 deliverable.** Step-by-step V0 → V1.

Ordering principle: **the two risks that could invalidate the architecture are tested first**,
before any subsystem is built on top of them.

---

## V0 — Architecture (this phase)

| Deliverable | Status |
|---|---|
| ARCHITECTURE_AUDIT.md | ✅ |
| LICENSING.md | ✅ |
| BUILD.md | ✅ |
| DEPENDENCY_MAP.md | ✅ |
| ROADMAP.md | ✅ (this) |
| **Sign-off on the 5 decisions** (AUDIT §9) | ⏳ **awaiting approval** |

No structural work proceeds until sign-off, per the brief's closing instruction.

---

## V0.5 — Proof of Concept (the gate)

Brief §46 defines nine acceptance criteria. Everything below exists to answer **R1** (is LOK's
Impress surface deep enough?) and the §5 open question (one C++ binary, or C++ host + higher-level
server?) with measurements rather than opinion.

**Rule: no tablature, no chords, no sections, no beat grid until this passes.**

### Step 1 — Prove LOK loads and renders (1 spike, no architecture)

Smallest possible C++ program. Throwaway.

```
lok_init_2("/usr/lib/libreoffice/program") → documentLoad(fixture.odp)
→ getParts() → paintPartTile(part 0) → write PNG
```

**Passes when:** a recognisable slide PNG appears on disk.
**Answers:** does the prebuilt distro LOK work at all, and what does cold start actually cost?

### Step 2 — Probe the editing surface (**this is the R1 gate**)

Systematically try the `.uno:` commands V1 needs, and **record which work**:

| Requirement (brief §9) | Probe |
|---|---|
| add / delete / duplicate / reorder slide | `.uno:InsertPage`, `.uno:DeletePage`, `.uno:DuplicatePage`, `.uno:MovePageDown` |
| edit text | `postMouseEvent` (double-click) + `postKeyEvent` |
| insert text box / image / shape | `.uno:Text`, `.uno:InsertGraphic`, `.uno:BasicShapes.*` |
| move / resize / align | `.uno:Position`, alignment commands |
| save ODP / PPTX / PDF | `saveAs` with three format strings |

**Output: `docs/LOK_CAPABILITY_MATRIX.md`** — works / works-with-effort / missing.

**Gate:** if too much is missing, stop and reconsider before building a server on it. The
fallback (patch `init.cxx`, AUDIT §5) is viable but changes the cost estimate materially, and
that is a decision to take deliberately.

### Step 3 — Decide the server shape

With Steps 1–2 measured, settle DEPENDENCY_MAP.md §5: one C++ binary vs. C++ LOK host +
TypeScript/Go server. **Record as ADR-002.** Deciding this on evidence rather than taste is the
whole reason Steps 1–2 come first.

### Step 4 — Minimal vertical slice

Only now does real structure appear:

```
server/lok/       load, getParts, paintPartTile, saveAs
server/api/       WebSocket: {loadProject, getSlide, setSlideTime, play, pause, seek}
server/transport/ THE master clock
frontend/         slide image + play/pause + a bare timeline
```

### Step 5 — The §46 acceptance test

1. presentation loads ✓
2. a slide renders ✓
3. existing editing preserved (per the Step-2 matrix) ✓
4. music file loads ✓
5. audio plays ✓
6. playback position available ✓
7. timeline displayed ✓
8. two slides have manual timestamps ✓
9. **slides change according to audio time** ✓

```
00:00 → Slide 1
00:10 → Slide 2
```

### Step 6 — Containerise immediately

`docker compose up` → `http://localhost:8080` reproduces Step 5. Container compatibility is
architectural (brief §50 R9), so it is proven at the PoC, not deferred.

**V0.5 exit criteria:** all nine §46 criteria pass **inside the container**, and
`LOK_CAPABILITY_MATRIX.md` + ADR-002 exist.

---

## V1 — Presentation + Audio Sync (first usable release)

Built only on what V0.5 proved.

### 1. Project format (do this first — everything persists through it)

```
my-show.mpw/
├── project.json        { schemaVersion: 1, presentation, audio, sections[],
│                         slideSync[], markers[], guitarTracks[] }
├── presentation.odp    LibreOffice owns this entirely
├── audio/
└── cache/waveform.dat
```

Rules from the brief: schema versions + migrations from day one (§34); **never** stuff project
data into LibreOffice document fields (§8); atomic writes — temp + rename (§35).

*Prior art: the existing React app's schema-version + migration discipline (`migrateDeck`) and
its atomic-write lesson in the MCP server carry over directly.*

### 2. Command bus (§26) — before the UI, not after

Every operation is a named, schema-validated command:

```
presentation.addSlide · presentation.deleteSlide · presentation.duplicateSlide
timeline.setSlideTime · timeline.addMarker · timeline.createSection
music.loadTrack · transport.play · transport.pause · transport.seek
```

Two properties that must hold from the first command:
- **The UI has no logic the command bus lacks** — this is what makes §27's AI integration a
  transport change later rather than a rewrite.
- **Every mutating command is undoable** (§25). Retrofitting undo is far harder than designing
  for it; the existing app's snapshot-based undo is a proven, cheap pattern to reuse.

### 3. Transport — the single master clock (§23)

Owner of time. Slides, timeline, playhead subscribe. Seek is one atomic operation.
Time stored as **integer milliseconds**; formatted strings are display-only, never state (§10).

### 4. Audio + waveform

Decode via FFmpeg → PCM → cached peak file. Play/pause/seek/scrub/position/duration/volume.
Cache waveform peaks so reopening a project is not a re-analysis (§14).

### 5. Timeline (generic from the start)

A track *container*, not hardcoded rows — V2/V3 add sections, beats, chords, tabs without a
redesign (§12). V1 ships two tracks: **Slides** and **Waveform**.

### 6. Slide sync (the core feature, §11)

Type a timestamp · drag a marker · nudge by ms/seconds · set-at-playhead · jump-to-slide.
Snapping arrives in V2 with the beat grid; V1 is exact-time only.

### 7. Presentation playback (§24)

"Start from Music": audio starts, timeline runs, slides switch on their timestamps, and the
deck stays correct across seeks.

**V1 exit criteria:** create/open/save a project; edit a presentation; import a song; place
slides on the timeline; press play and watch the deck follow the music — in the container.

---

## V2 → V5 (sequence only; not planned in detail yet)

| Version | Adds |
|---|---|
| **V2** | BPM, beat grid, bars, snapping, sections, markers, chord track |
| **V3** | Guitar tracks, tunings, structured tablature, measures, chord diagrams, fretboard/scales |
| **V4** | Multi-track audio, mixer, stems, automatic tempo/beat detection (Python service earns its place here) |
| **V5** | AI over the *existing* command bus — no new mutation paths, agent changes undoable |

Detailed planning for each happens at its own boundary, on evidence from the one before.

---

## Sequencing rationale

Three orderings are deliberate and worth defending:

1. **LOK capability probe before any server code.** R1 is the risk that invalidates the
   architecture; discovering it in month three would be expensive.
2. **Command bus before UI.** §26/§27 only hold if no logic ever lives solely in a click
   handler. That is an ordering property — it cannot be added later without rework.
3. **Container at PoC, not at release.** Brief §50 R9. Retrofitting containerisation is the
   classic way this requirement quietly fails.

---

## Immediate next actions (on approval)

1. Approve the five decisions — ARCHITECTURE_AUDIT.md §9
2. `sudo apt install` the prerequisites — BUILD.md §7
3. Step 1 spike: LOK loads an `.odp` and writes a slide PNG
4. Step 2: produce `LOK_CAPABILITY_MATRIX.md` ← **the real gate**
