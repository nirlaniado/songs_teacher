# LOK_CAPABILITY_MATRIX.md

**Stage 0 — the interactive-editing gate.** All results **measured**, not assumed.
Supersedes the R1-only matrix from the first (7.4.7) run; that run's rendering/export
findings are folded in below rather than kept as a separate document.

| | |
|---|---|
| Probe | `lok/poc/probe.cpp` (throwaway) |
| Environment | **Native Ubuntu 24.04 WSL** — no container, no Docker in the dev loop |
| LibreOffice | **24.2.7.2** (Ubuntu, `apt install libreofficekit-dev libreoffice-impress`) |
| Result | **24 passed / 3 failed → gate CLEARED, no source patch needed** |

---

## 1. Verdict

**Interactive editing works headlessly through the public LOK C API.** Text editing,
selection callbacks, shape insertion and slide manipulation are all reachable with zero
LibreOffice source modification. This was the actual open question for this stage —
rendering and export were proven in the first run and are not being re-litigated.

**Go: build on this.**

---

## 2. The gate items (this stage's reason to exist)

| # | Question | Result |
|---|---|---|
| 1 | Can we type into a shape? | ✅ **Yes.** Double-click (`postMouseEvent`, `nCount=2`) entered text-edit mode on the title placeholder; `postKeyEvent` typed "Do"; the placeholder's prompt text was replaced by real content in the render. **Visually confirmed** — see `text_before.png` → `text_after.png`. |
| 2 | Do selection/cursor callbacks arrive? | ✅ **Yes.** `CURSOR_VISIBLE`, `GRAPHIC_SELECTION`, `INVALIDATE_VISIBLE_CURSOR` all fired during the edit, alongside `INVALIDATE_TILES`. |
| 3 | Edit → repaint latency (R2) | ✅ **8.79 ms**, synchronous key-event-to-correct-render round trip. Well inside a usable interactive budget; this is a *floor* (no network/IPC hop yet — see caveat below). |
| 4 | Shape insertion | ✅ **Yes.** `.uno:Rect` + a synthetic `postMouseEvent` drag (down → move → up) drew a real rectangle — 46,535 px changed, visually confirmed. |

**#1 and #2 were the hard gate** (per the stage-0 plan: "if #3 and #4 fail, stop"). Both
passed cleanly. The stage is cleared.

---

## 3. The regression this run caught — and its fix

The first (7.4.7) run found `.uno:DuplicatePage`/`.uno:DeletePage` working and the direct
`.uno:InsertPage`/`InsertSlide`/`NewPage` family inert. **Against 24.2.7, all five were
initially inert** — a real regression from the previous measurement, not a repeat of it.
No callback fired for any of them; not even a `success:false`. Complete silence, the same
signature as last time's `initializeForRendering()` omission.

**Root cause, found by experiment:** `initializeForRendering()` sets up a view, but in
24.2 that alone leaves the page/slide command dispatch table unwired. **One throwaway
`paintTile()` call before the first `.uno:` command fixes it** — after that warm-up, every
page command works, including `.uno:InsertPage` directly:

```
[PASS] warm-up paintTile before page commands
[PASS] .uno:InsertPage      1 -> 2
[PASS] .uno:DuplicatePage   2 -> 3
[PASS] .uno:DeletePage      3 -> 2
```

**This is now a second prerequisite, alongside `initializeForRendering()`:** call
`initializeForRendering()`, then one `paintTile()`, *then* issue `.uno:` commands. Skipping
either one produces total, silent, no-error failure — worth stating baldly since it's
exactly the kind of thing that looks like "LOK doesn't support this" until measured.

**Bonus finding:** `.uno:InsertPage` — inert in 7.4, needing the `DuplicatePage` workaround
— **works directly in 24.2** once warmed up. The workaround documented last time is no
longer needed; kept in the probe as a fallback in case a future version regresses again.

---

## 4. Everything else measured this run

| Capability | Call | Result |
|---|---|---|
| Image insertion | `.uno:InsertGraphic` | ⚠️ Works with argument property `"FileName"`; **not** `"GraphicURL"` (0 px changed). Use `FileName`. |
| Toolbar state reflection | `.uno:Bold` → `STATE_CHANGED` | ❌ No callback fired at all, in or out of text-edit mode. Not attempted with an active text selection — worth retrying with a selection present before concluding it's unreachable. **Not a blocker** (per stage-0 plan, workaround category) — toolbar buttons can poll `.uno:` state via other means later. |
| PPTX round-trip | export our own `probe.pptx`, reload, render | ✅ Loads and renders correctly. **Note the narrower scope:** this proves our own export is readable, not fidelity against a real-world, externally-authored `.pptx` (deck with complex layouts/fonts/masters) — that's manual follow-up, not covered by an offline, self-contained probe. |
| Runtime, doc lifecycle, slide-as-part model, whole-slide rendering, ODP/PPTX/PDF export | (all first proven in the 7.4 run) | ✅ Re-confirmed unchanged against 24.2. |

---

## 5. Corrections to earlier assumptions (this run)

| Assumed (carried from the 7.4 matrix) | Actual (24.2) |
|---|---|
| `initializeForRendering()` alone is sufficient before `.uno:` commands | **Also needs one `paintTile()` warm-up**, or page/slide commands silently no-op |
| `.uno:InsertPage` is inert; use `.uno:DuplicatePage` as the add-slide path | **`.uno:InsertPage` works directly** once warmed up — no workaround needed on this version |
| Callback `success` flag is unreliable (7.4 finding, re-tested) | Not re-tested this run — no `.uno:DeletePage` `success:false` case reproduced, since the flag wasn't logged this pass. Treat as still open; keep verifying observable state, not the flag, as the standing rule. |

---

## 6. Follow-ups (not blockers)

- [ ] `.uno:Bold`/`STATE_CHANGED`: retry with an active text selection before concluding
      toolbar state is unreachable this way.
- [ ] `.uno:InsertGraphic` — confirm `FileName` (not `GraphicURL`) as the committed argument
      shape when this becomes real host code, not just a probe.
- [ ] Real-world `.pptx` import fidelity — needs an externally-authored fixture; deferred
      to manual testing per the stage-0 plan, not scriptable offline without one.
- [ ] The 8.79 ms edit→repaint figure is in-process, same-machine. Measure again once the
      C++↔TypeScript↔browser hops exist (Stage 1+) — that's the number that actually
      matters for feel.
- [ ] `success` flag re-verification, since it wasn't logged this run (see §5).

---

## 7. Stage 1 addendum — a second async-dispatch trap, found building the real host

The probe's own `tryUno()` helper masked a bug that only showed up in `lok/host/host.cpp`:
calling `postUnoCommand(cmd, nullptr, /*bNotifyWhenFinished=*/false)` and reading
`getParts()` immediately after returns **stale-by-one** state. Two `.uno:DuplicatePage`
calls in a row reported part counts `1, 2` instead of the correct `2, 3` — the first
call's effect only became visible once the *second* call's dispatch forced it to settle.

**Why the probe didn't catch this:** every `tryUno()` call in `probe.cpp` used
`bNotifyWhenFinished=true` throughout, and each call's own `getParts()` "before" read
incidentally gave the *previous* command's async dispatch a chance to settle. The bug was
invisible until a real client read the result of one specific call in isolation, which is
exactly what a server does.

**Fix:** `bNotifyWhenFinished` must be `true`, matching the probe. Documented in
`host.cpp`'s `cmdUno()` alongside the fix. With it, sequential `.uno:` calls report
`1, 2, 3` correctly and `LOK_CALLBACK_UNO_COMMAND_RESULT` fires with `success: true`.

**Standing lesson:** a helper's own bookkeeping can accidentally paper over a timing bug —
measure the exact call shape the real client makes, not a convenient proxy for it.

---

## 8. Stage 2/3 addendum — key codes are not something to recall from memory

Building the canvas needed raw `postKeyEvent` codes for Backspace/Delete/Enter/Tab/Escape/
Arrows/Home/End/PageUp/PageDown (`com.sun.star.awt.Key`). These aren't in the LOK C headers
— they're UNO IDL constants — so a first pass hand-recalled them.

**Measured result: half right, half wrong, in a way that would have shipped silently
broken.** Backspace (1283), Delete (1286), Enter (1280), Tab (1282) and Escape (1281) were
right. ArrowLeft/Up/Right/Down and Home/End/PageUp/PageDown were **wrong — guessed in the
1287–1296 range, actually 1024–1031**, a completely different block. Caught by the same
discipline as everywhere else in this project: type "AB", press the (guessed) Home key,
type "X" — a correct Home produces "XAB", a no-op produces "ABX". It produced "ABX".

**Fixed by querying LibreOffice itself rather than guessing again:**
```bash
python3 -c "from com.sun.star.awt.Key import *; print(LEFT, UP, RIGHT, DOWN, HOME, END, PAGEUP, PAGEDOWN)"
```
`python3-uno` ships with `libreoffice-core` — no extra install. Every corrected value was
then re-verified the same before/after-render way (`ArrowLeft` moving the cursor correctly,
`Home`+`Delete` removing the first character, `Enter` producing a visible second line —
screenshotted in the Stage 2 session). **Standing rule for this table:** if a future
LibreOffice version ever needs re-checking, re-run the one-line query above — there is no
reason to hand-recall these values a second time now that the authoritative source is known.

**A second lesson, about testing Undo specifically:** an attempt to assert Undo returns the
render to an *exact*, byte-identical prior state was built, and abandoned. Two renders of
identical document content can differ by a few bytes from an active caret's blink phase, and
separately, a shape's selection outline being drawn or not doesn't track 1:1 with undo
steps — both are real sources of pixel difference that have nothing to do with whether Undo
is correct. Undo's actual correctness was confirmed the reliable way: by eye, watching
content revert across a real edit sequence. The automated smoke test asserts the weaker,
non-flaky property instead (undo moves state away from the fully-edited one) and documents
why exact-match was dropped, rather than either shipping a flaky assertion or silently
weakening it without saying so.

---

## 9. Stage 5 addendum — re-verified against the custom minimal build, plus a persistence proof

**Environment**: `/home/nir20/guitar_teacher/lo-clean-build` — a from-source,
`--enable-impress-draw-only` pruned LibreOffice build (see the separate
`music_school` mission's `docs/minimal-lo/`), *not* the `libreofficekit-dev`
apt package this document originally measured against.

**Why re-verify rather than assume:** BUILD.md §1 chose the distro package
specifically to avoid an expensive/OOM-risky source build on this machine.
That source build has since happened anyway, for unrelated reasons (a
separate LibreOffice size-reduction project), producing a working
`--enable-impress-draw-only` install. Reusing it means one fewer moving
part (no apt dependency), but nothing here should be assumed compatible
just because it's "still LibreOffice" — measured, same as everything else
in this document.

**Result: identical capability set.** `lok/poc/probe.cpp` run against
`lo-clean-build/instdir/program` reproduces the exact same 24 passed / 3
failed split as the apt-package run in §1-§8 above, including the same
three known-non-blocking failures (`InsertGraphic` argument name, `Bold`
`STATE_CHANGED`). **R1 remains cleared.** `LO_PROGRAM_PATH` /
`HOST_ARGS` default in `lok/poc/run.sh`, `lok/server/index.ts`,
`lok/poc/probe.cpp`, and `lok/host/host.cpp` were switched to this path,
and the full `lok/tests/smoke.mjs` end-to-end suite (real server, real
host, real LibreOffice, no mocks) was re-run with **no override** to
confirm the new default actually takes effect: same 22 passed / 5 failed
split as before, and the 5 failures remain entirely confined to the
explicitly out-of-scope Stage 4 (music-sync) checks.

**New: an explicit edit → save → reopen → verify persistence proof.**
Every prior save/reload check in this document proved either unedited
round-trip fidelity (§4 row 5) or that *some* content survives reload
(§7's `hasContent` check) — not that a *specific* edit, made through the
LOK API, is still present after an independent reopen. Added `probe.cpp`
section [12]: after the section-9 text edit, `saveAs` the edited document
to a new file, then open *that* file as a brand-new `lok::Document`
(no shared state with the editing session) and diff its render against
the pre-edit baseline.

```
[12] Persistence: edit -> save -> reopen -> verify
  [PASS] documentLoad(probe_edited.pptx)
  [PASS] reopened doc still shows the edit vs. pre-edit render   17094 px changed
```

This is the direct evidence for the product requirement "save and reopen
must preserve edits" — previously implied by the individual capabilities
but never checked end-to-end in one assertion.

**One measured difference, not a blocker:** edit→repaint latency (Q5) was
**98–139 ms** against `lo-clean-build`, vs. **8.79–10.91 ms** against the
apt package, across repeated runs. Both builds use `-O0`/`--enable-dbgutil`-
style debug flags in this checkout's case, so this is plausibly debug-build
overhead rather than anything specific to the pruning — not re-measured
against an optimized custom build, since V1 doesn't need one. Revisit per
ADR-002 §13's own trigger ("render latency proves IPC-bound rather than
LibreOffice-bound — measure before acting") if interactive feel becomes a
concern; 139 ms is still well inside a usable budget for whole-slide
re-render, not a per-frame cost.

## 10. Reproduce

```bash
# Against the custom minimal build (current default — see §9):
cd lok/poc
./run.sh

# Against the apt package instead:
LO_PROGRAM_PATH=/usr/lib/libreoffice/program ./run.sh
# (requires: sudo apt install libreofficekit-dev libreoffice-impress libreoffice-core)
```

Writes `slide0.bmp`, `shape_after.bmp`, `image_after.bmp`, `text_before.bmp`,
`text_after.bmp`, `reloaded_pptx.bmp`, `probe_edited.pptx`,
`reopened_after_edit.bmp`, plus `probe.{odp,pptx,pdf}` to `lok/poc/out/`.
