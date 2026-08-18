# ADR-002 — Server shape: minimal C++ LOK host + TypeScript server

**Status:** Accepted · **Supersedes:** the open question in DEPENDENCY_MAP.md §5
**Depends on:** ADR-001 (Option D), LOK_CAPABILITY_MATRIX.md (R1 cleared)

---

## 1. Decision

Three processes, each owning what it is genuinely best at:

```
Browser — React + existing MPW UI
   │   HTTP (JSON + PNG + audio)
   ▼
TypeScript server — orchestration, timeline, schedule, API
   │   line protocol over stdin/stdout
   ▼
C++ LOK host — LibreOfficeKit only
   │   in-process C API
   ▼
LibreOffice (unmodified)
```

**C++ owns only what requires LibreOffice.** Everything else is TypeScript.

---

## 2. Why not a monolithic C++ server

| Concern | Monolith | Chosen |
|---|---|---|
| Existing React/TS work (timeline, waveform, transport, stems, tabs, `ops.ts`) | Rewrite in C++ | **Reused directly** |
| Iteration speed on timeline/UX — where the product actually lives | Recompile C++ | Hot reload |
| A crash in music code | Takes down the document engine | Cannot — different process |
| Contributors needed | C++ for everything | C++ only for a ~300-line host |
| Schema/validation (Zod, JSON) | Hand-rolled in C++ | Mature ecosystem |

The decisive point: **the product's value is the music/timeline layer, and that layer already
exists in TypeScript.** Rewriting working, tested code into the language with the slowest
iteration loop would be paying a large cost to lose an asset.

C++ earns its place for exactly one thing — LOK is a C API and needs a C/C++ caller. That is a
~300-line boundary, not a server.

**Cost accepted:** one IPC hop (sub-millisecond locally) and two runtimes in the image.

---

## 3. The exact C++ ↔ TypeScript boundary

### C++ owns (and nothing more)

| Responsibility | LOK call |
|---|---|
| Load/close a presentation | `documentLoad`, `initializeForRendering` |
| Report slide count and names | `getParts`, `getPartName` |
| Render a slide to PNG | `setPart`, `paintTile` + zlib PNG encode |
| Slide manipulation | `postUnoCommand` (`.uno:DuplicatePage`, `.uno:DeletePage`) |
| Export | `saveAs` (odp / pptx / pdf) |
| Document geometry | `getDocumentSize` |

### TypeScript owns

Project model and `project.json`; **timeline state**; slide↔time schedule; transport
coordination; HTTP/WS API; host process supervision; validation; static assets.

### Prohibited, in both directions

- **No timeline, waveform, tempo, section, marker or transport logic in C++.** If a change
  needs C++ *and* touches timing, the boundary has been drawn wrong.
- **No LibreOffice concepts in TypeScript** beyond opaque slide indices. TS must never learn
  what a `.uno:` command is; it calls `host.duplicateSlide(i)`.

CI guard: `grep -rn "timeline\|waveform\|tempo\|bpm\|transport" host/` must return nothing.

---

## 4. IPC / protocol

**Line-delimited text over stdin/stdout**, one request per line, one response per line.

```
→ OPEN /data/deck.odp
← OK 2
→ RENDER 0 1280 720 /cache/s0.png
← OK /cache/s0.png
→ QUIT
```

**Why stdio:** no ports, no auth surface, no orphaned sockets, and the child dies with the
parent. Node's `child_process` handles it natively. The existing MCP server already proved this
transport in this project.

**Why a line protocol rather than JSON-RPC:** the surface is five verbs. Hand-rolling a JSON
parser in C++ to carry `RENDER 0 1280 720` would be more code and more failure modes than the
thing it encodes. **Upgrade trigger:** the moment a message needs nesting or optional fields,
move to JSON-RPC — the framing (one message per line) is already correct, only the payload
changes.

**Binary never crosses the pipe.** The host writes PNGs to a shared cache directory and returns
the path; the server serves them over HTTP with normal caching. This avoids base64 bloat and
binary framing entirely, and makes slide images debuggable as ordinary files.

---

## 5. Process lifecycle and crash handling

- **One host process per open document** (Collabora's model, ARCHITECTURE_AUDIT.md §3.4). LOK
  is not built for many documents in one process, and isolation is the point.
- **Supervised by the TypeScript server**: spawn on open, `QUIT` on close, `SIGKILL` after a
  grace period.
- **Crash → restart + replay.** The server holds the document path and last-known state, so it
  re-spawns, re-opens and re-renders. In-flight requests reject with a typed error.
- **Restart-loop guard:** more than 3 crashes in 60 s stops retrying and surfaces a hard error,
  rather than thrashing.
- **The user's work is never only in the host.** Timeline data lives in `project.json`, saved
  independently of the ODP. A host crash costs a re-render, not data.

---

## 6. Ownership of presentation state

**LibreOffice is the sole owner.** The `.odp` is the single source of truth for slide content —
shapes, text, layout, masters. Neither the server nor the browser keeps a parallel model.

The server caches only *derived, disposable* facts: slide count, names, rendered PNG paths. All
of it is reconstructible by re-opening the document, which is exactly why a host crash is
survivable.

This upholds brief §8: project data never gets stuffed into LibreOffice document fields, and
presentation data is never duplicated outside LibreOffice.

---

## 7. Ownership of timeline state

**TypeScript, exclusively.** Slide timestamps, sections, markers, tempo — all in `project.json`
beside the `.odp`:

```
my-show.mpw/
├── project.json        ← TypeScript owns
├── presentation.odp    ← LibreOffice owns
└── audio/song.wav
```

C++ never sees a timestamp. The two files are edited by two owners and joined only by slide
*index*, which is the entire coupling between the presentation and the music.

---

## 8. Master-clock ownership

**The browser owns the clock. This is forced by physics, not preference: the container has no
audio device, so audio can only play in the browser, and the only truthful clock is the one
attached to the audio that the user is actually hearing.**

| Owner | Owns |
|---|---|
| **Browser** | The clock. Audio playback, current position, rAF tick, resolving which slide is due |
| **Server** | The *schedule* — the authoritative slide→time mapping it hands the browser |

Brief §23 ("one master clock") holds: there is exactly one clock, in the browser, and slides,
playhead and (later) tabs/chords all subscribe to it.

**Why not a server-side clock pushing slide changes:** every switch would cost a network
round-trip, seeking would lag, and a WebSocket hiccup would desync the deck from audio the user
can hear. Sync must not depend on the network being healthy.

> *Prior art: the previous project proved the failure mode — two independent audio clocks drifted
> apart within seconds. One owner, everything else subscribes.*

---

## 9. How slide switching reaches LibreOffice

For playback, **it doesn't** — and that is the design.

```
Browser clock ticks
  → resolve schedule locally  (pure function of time)
  → slide index changed?
      → swap to the already-cached PNG        ← no server call, no LOK call
```

Slides are **pre-rendered on open** and cached as PNGs. Switching is an image swap: no IPC, no
LibreOffice, no network on the hot path. This is what makes a cue land on the beat instead of
30 ms late.

LOK is reached only for **editing** (`.uno:DuplicatePage`, text edits), which invalidates that
slide's PNG and triggers a re-render — off the playback path entirely.

---

## 10. Container topology

**One container, one service, for V1** (brief §37 — no premature microservices):

```
mpw container
├── node          server + static frontend   (PID 1, supervises)
├── mpw-host      C++ LOK host               (child, one per document)
└── LibreOffice   loaded in-process by host
volumes: ./projects → /data/projects
ports:   8080
```

Splitting the host into its own container was rejected: it would need a network protocol and
shared-volume image passing to solve a problem — process isolation — that a child process
already solves.

---

## 11. Future Python / AI integration

Both attach at the **same** place: the TypeScript command layer.

```
React UI ─┐
Python    ├─→  Command Bus (TS)  ─→ domain ─→ host (C++)
AI agent ─┘
```

Python (beat detection, stem separation) is a **sidecar that returns data**, never a controller:
`POST /analysis/beats` → `{beats: [...]}` → the server writes them to `project.json`. It never
touches LibreOffice or the host.

AI (V5) calls the identical commands the UI calls — brief §27. Because no logic lives in a click
handler, adding an agent is a transport change, not a rewrite. `ops.ts` already demonstrates
this shape in the existing codebase.

---

## 12. Failure and reconnect behaviour

| Failure | Behaviour |
|---|---|
| **Host crashes** | Server re-spawns, re-opens, re-renders. UI shows "reconnecting"; timeline stays fully usable because it is server-side data. |
| **Host hangs** | Per-request timeout (10 s) → kill → restart. A wedged LOK never wedges the app. |
| **Server restarts** | Browser retries with backoff; `project.json` is on disk, so nothing is lost. |
| **Browser disconnects** | Server is stateless per-request; reconnect refetches the schedule. |
| **Audio fails to decode** | Presentation editing continues; timeline shows "no audio". Degraded, not broken. |
| **Slide render fails** | That slide shows a placeholder; the rest of the deck is unaffected. |

Principle: **a failure in one layer degrades that layer only.** No single fault takes the app
down — which is the payoff for accepting the extra process in §2.

---

## 13. Consequences

**Good:** existing React/TS work is reused, not rewritten; C++ is ~300 lines with one clear job;
fault isolation between document engine and music layer; slide switching needs no network; both
future consumers (Python, AI) attach at one place.

**Accepted:** two runtimes in the image (~1.1 GB, measured); one IPC hop; the line protocol needs
upgrading to JSON-RPC when the host surface grows.

**Revisit if:** the host surface exceeds ~15 verbs (→ JSON-RPC), or render latency proves
IPC-bound rather than LibreOffice-bound (→ measure before acting).
