# BUILD.md

**Phase 0 deliverable.** Build + containerisation strategy.

---

## 1. The headline decision: do not build LibreOffice

Verified on this machine:

```
$ apt-cache policy libreofficekit-dev
  Candidate: 4:24.2.7-0ubuntu0.24.04.6
  Backports: 4:25.8.7-0ubuntu0.25.10.1~bpo24.04.1
```

**LibreOfficeKit headers and runtime are available prebuilt.** Combined with the machine's
constraints, this settles the strategy.

| | Source build | **Distro package** ← chosen for V1 |
|---|---|---|
| Disk | 15–25 GB | ~1 GB |
| Time | **8–12 h** on 4 cores / 11 GB (est. from ~5 h on 16 GB/8-core) | ~2 min |
| RAM risk | **Real OOM risk when linking at `-j4`** | none |
| Modify core? | Yes | No |
| Needed for V1? | **No** | — |

This machine is **4 cores / 11 GB / 933 GB free**. Disk is ample; **CPU and RAM are the binding
constraints**, and linking LibreOffice is memory-hungry. A full source build here is an
overnight job with a genuine chance of an OOM kill partway through.

> **Do not source-build until a patch is actually required** (ARCHITECTURE_AUDIT.md §5). If that
> day comes, do it in CI or on a larger machine, not on the dev laptop.

### Installing the dependency (manual — needs sudo)

```bash
sudo apt update
sudo apt install -y \
  libreofficekit-dev \
  libreoffice-core libreoffice-impress libreoffice-draw \
  libreoffice-common fonts-liberation

ls /usr/include/LibreOfficeKit/          # expect LibreOfficeKit.h, LibreOfficeKitEnums.h
ls /usr/lib/libreoffice/program/         # expect libmergedlo.so, soffice.bin
```

`LibreOfficeKit` is loaded by pointing at the **install path** (`/usr/lib/libreoffice/program`),
not by linking a `.so` at build time — `lok_init_2()` dlopens it. That keeps our binary
independent of the exact LibreOffice build.

---

## 2. If a source build ever becomes necessary

For the record, tuned for a memory-constrained box:

```bash
git clone https://git.libreoffice.org/core libreoffice-core && cd libreoffice-core
./autogen.sh \
  --disable-debug --enable-release-build \
  --without-java --without-help --without-myspell-dicts \
  --disable-gtk3 --enable-headless \
  --with-lang=en-US
make -j2          # -j2, not -j4: linking is the OOM risk
```

Notes: `--enable-headless` is the container-relevant `vcl` backend; `--disable-gtk3` drops the
desktop UI we do not use; `--with-lang=en-US` avoids the >25 GB all-languages case. Expect
several hours. Never run this inside a container layer — build outside, copy artifacts in.

---

## 3. Our own build

Three independent toolchains, deliberately decoupled:

| Part | Toolchain | Notes |
|---|---|---|
| `server/lok/` | C++20, CMake | The only code that includes `LibreOfficeKit.h` |
| `server/` (rest) | Same binary, but **no LibreOffice headers** | Enforced by include-path hygiene + a CI grep |
| `frontend/` | TypeScript + Vite | Static bundle, served by the server |
| `services/` | Python 3.12 + FastAPI | Optional; not on the V1 critical path |

`cmake` is **not currently installed** — `sudo apt install -y cmake ninja-build` when server work
begins.

**CI guard worth having from day one:**

```bash
# Fails if LibreOffice leaks outside the wrapper.
! grep -rn "LibreOfficeKit" server/ --include=*.cpp --include=*.hpp \
    | grep -v "^server/lok/"
```

That one check is what keeps ARCHITECTURE_AUDIT.md §2's rule true over time, rather than by
good intentions.

---

## 4. Containerisation

Container-compatibility is an architectural requirement (brief §9/R9), so the container exists
from the first PoC — not as a packaging step later.

### Image strategy — multi-stage

```
Stage 1  builder    build server (C++) + frontend (node)
Stage 2  runtime    debian-slim + libreoffice-core/impress + our binary + static assets
```

Do **not** ship the builder toolchain. Expect **~1–2 GB** runtime, dominated by LibreOffice.
Trim: no language packs beyond en-US, no Java, no Writer/Calc where the packaging allows.

### Compose shape for V1 — one service

```yaml
services:
  mpw:
    build: .
    ports: ["8080:8080"]
    volumes:
      - ./projects:/data/projects      # persistent; survives container replacement
    environment:
      PROJECTS_DIR: /data/projects
      LO_PROGRAM_PATH: /usr/lib/libreoffice/program
      API_PORT: "8080"
      LOG_LEVEL: info
```

Resist microservices in V1 (brief §37). The optional Python analysis service is added only when
something actually needs it.

### Container specifics that matter

- **Headless.** No X server; `vcl`'s headless backend. Set `SAL_USE_VCLPLUGIN=svp`.
- **`HOME` must be writable.** LibreOffice insists on a user profile directory; a read-only
  `HOME` fails in confusing ways. Give each Kit process its own profile dir under `/tmp`.
- **Fonts are part of fidelity.** A container without fonts renders documents wrongly. Ship
  `fonts-liberation` at minimum; document the font set as an interoperability decision.
- **`/tmp` sizing.** LibreOffice writes temp aggressively; a tiny tmpfs causes odd failures.
- **Audio decoding runs server-side.** FFmpeg in the image (not currently installed on host).
- **No `--privileged`, no host X socket.** If either is needed, an architectural line has been
  crossed.

---

## 5. Configuration

Environment-driven, no machine-specific paths in code (brief §39):

```
PROJECTS_DIR      /data/projects
TEMP_DIR          /tmp/mpw
LO_PROGRAM_PATH   /usr/lib/libreoffice/program
FFMPEG_PATH       /usr/bin/ffmpeg
API_PORT          8080
LOG_LEVEL         info
MAX_KIT_PROCESSES 4
```

---

## 6. CI targets

1. Build server + frontend
2. Unit tests (domain logic, no LibreOffice — must run without it installed)
3. **Include-hygiene guard** (§3)
4. Integration tests against a real LOK (needs the package)
5. Build container image
6. Smoke test: `docker compose up` → load a fixture `.odp` → assert slide count + one rendered PNG

Step 2 running **without** LibreOffice present is the practical proof that the domain layer is
genuinely decoupled.

---

## 7. Immediate manual prerequisites

```bash
sudo apt update && sudo apt install -y \
  libreofficekit-dev libreoffice-core libreoffice-impress libreoffice-draw \
  cmake ninja-build ffmpeg fonts-liberation
```

None of this is needed to review the Phase-0 documents — only to start the PoC.
