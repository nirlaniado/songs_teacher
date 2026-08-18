# DEPENDENCY_MAP.md

**Phase 0 deliverable.** V1 dependency list + internal dependency direction.

---

## 1. Internal dependency direction

Dependencies point **inward**. The domain never depends on transport, UI, or LibreOffice.

```
frontend/ ─────────────┐
services/ (python) ────┤
                       ▼
                   api/  (WebSocket + HTTP; no business logic)
                       │
                       ▼
                 commands/  ◄── the one surface UI, HTTP and future AI all use
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   transport/     timeline/       music/        guitar/      ← pure domain,
        └──────────────┴──────────────┴──────────────┘          no LibreOffice
                       │
                       ▼
                  project/        ← project.json, schemas, migrations
                       │
                       ▼
                    lok/          ← ONLY component including LibreOfficeKit.h
                       │
                       ▼
              LibreOffice (Kit process, unmodified)
```

**Two invariants, both CI-enforceable:**

1. `LibreOfficeKit.h` appears **only** under `server/lok/`.
2. `transport/`, `timeline/`, `music/`, `guitar/` compile and test with **LibreOffice absent**.

Invariant 2 is the honest test of decoupling — if the domain suite needs LibreOffice installed
to run, the layering has already leaked.

---

## 2. V1 runtime dependencies

### Document engine

| Dependency | Version | Licence | Why | Alternative considered |
|---|---|---|---|---|
| LibreOffice core + Impress | 24.2.7 (pin) | MPL-2.0 | The document engine | Building from source — rejected, BUILD.md §1 |
| LibreOfficeKit headers | matches above | MPL-2.0 | The integration contract | UNO C++ API directly — far heavier, less stable |

### Server

| Dependency | Purpose | Licence | Notes |
|---|---|---|---|
| C++20 toolchain (gcc 13.3 ✓ present) | Server + LOK wrapper | — | Already available |
| CMake + Ninja | Build | BSD/Apache | **Not installed** |
| A WebSocket/HTTP library | Transport | — | **Deliberately not chosen yet** — see §5 |
| A JSON library | Commands, project format | — | Same |

### Audio

| Dependency | Purpose | Licence | Notes |
|---|---|---|---|
| FFmpeg (libavcodec/libavformat) | Decode WAV/MP3/FLAC/OGG → PCM | LGPL-2.1+ / GPL depending on build | **Not installed.** Build flags matter for licensing — LICENSING.md L5 |

Decode server-side and hand the browser both PCM-derived waveform peaks and a playable stream.
Never implement codecs by hand (brief §13).

### Frontend

| Dependency | Purpose | Licence |
|---|---|---|
| TypeScript, React 19, Vite | UI | Apache-2.0 / MIT |
| A virtualised-list library | Long timelines | MIT |
| A resizable-panel library | Impress-style panes | MIT |

Canvas/WebGL for waveform + timeline rendering; DOM for panels. **No presentation renderer in
React** — LibreOffice renders slides (brief §6).

### Optional (not V1-critical)

| Dependency | Purpose |
|---|---|
| Python 3.12 ✓, FastAPI, Pydantic | Future analysis: beat/section detection |
| librosa / aubio | Future tempo/beat detection |

---

## 3. Deliberately excluded from V1

Per brief §4 and §49: Electron, Tauri, Windows COM, a locally-installed LibreOffice *application*
(we use the library), GUI automation, screen scraping, VST/MIDI hosting, any LLM SDK, any
collaborative-editing/CRDT stack, any database (the project directory is the store).

**No database in V1** is a real decision: a project is a directory on a mounted volume
(brief §8), which keeps projects portable, inspectable and trivially backed up.

---

## 4. Dependencies the existing React app already provides

From `/home/nir20/libre_off` (see ARCHITECTURE_AUDIT.md §7) — already chosen, already working:

| Existing | Reuse |
|---|---|
| Zod schemas + `ops.ts` op vocabulary | Model for `shared/` schemas and `commands/` |
| Waveform rendering + rAF transport | Port to `frontend/timeline/` |
| Stem mixer (mute/solo/gain) | Port for §30 |
| Tab model + tuning presets + `padTabLines` | Seeds `guitar/` |
| MCP server | Model for the §28 API boundary |

These are prior decisions with working code behind them, not new dependencies to evaluate.

---

## 5. Choices deliberately deferred

Brief §48 says "evaluate additional libraries before adopting them", so these are **named as
open** rather than silently decided:

| Decision | Why deferred |
|---|---|
| C++ WebSocket/HTTP library | Depends on whether the server stays C++ throughout or the LOK wrapper becomes a subprocess with the server in TypeScript/Go. That is a real fork in the road — decide with the PoC's measurements, not now. |
| JSON + schema-codegen toolchain | Follows from the above |
| Waveform peak format/cache | Depends on measured file sizes |
| Audio delivery to browser (stream vs. decoded buffer) | Depends on measured seek latency |

**The most consequential open question** is the first: whether `server/` is one C++ binary, or a
small C++ LOK host plus a higher-level server. The PoC is scoped to answer it with evidence.

---

## 6. Currently missing on this machine

```bash
sudo apt install -y libreofficekit-dev libreoffice-core libreoffice-impress \
                    cmake ninja-build ffmpeg fonts-liberation
```

Present and sufficient: gcc 13.3, git 2.43, Python 3.12, Node 22.21, Docker 29.5.
