# LICENSING.md

**Phase 0 deliverable.** Reviewed against documentfoundation.org during this session.

> Not legal advice. Before any public distribution, have counsel review §6.

---

## 1. Upstream licences

| Component | Licence | Note |
|---|---|---|
| LibreOffice core | **MPL-2.0** | New contributions are dual **MPL-2.0 / LGPLv3+** |
| Code inherited from Apache OpenOffice | **Apache-2.0** | Present in parts of the tree |
| Bundled third-party libraries | Various (LGPL, BSD, MIT, …) | Must be enumerated per shipped binary |
| "LibreOffice" name and logo | **Registered trademarks** of The Document Foundation | Not covered by the source licence |

---

## 2. The fact that shapes the architecture

**MPL-2.0 is _file-level_ copyleft.** This is the single most consequential licensing fact for
this project, and it is why the architecture in ARCHITECTURE_AUDIT.md §5 looks the way it does.

- **Modify an existing MPL file** → that file's modifications must be released under MPL-2.0 and
  source made available.
- **Add a new file** → it may carry **our own licence**. MPL does not reach into it.
- **Combine into a "Larger Work"** (MPL §3.3) → explicitly permitted, and the larger work may be
  under different terms, provided MPL-covered files keep their licence and notices.

Consequence, stated directly:

> Because `server/timeline/`, `server/music/`, `server/guitar/`, `frontend/` and the project
> format are **new files in new modules that never modify LibreOffice source**, they are ours to
> licence. Only files we actually edit inside LibreOffice attract MPL obligations.

This is a strong argument for the "wrap, don't fork" decision — it is not merely a maintenance
preference, it materially limits copyleft reach.

### The LGPLv3+ side of the dual licence

Contributions are dual-licensed MPL-2.0 **and** LGPLv3+. We can rely on MPL-2.0 terms. Note that
LGPLv3 carries obligations MPL does not (notably relinking rights and anti-tivoisation). Since
we distribute as an open-source container and do not lock hardware, this is not expected to
bind, but it must be re-checked if a proprietary or appliance-style distribution is ever
considered.

---

## 3. Obligations we take on

Because V1 **dynamically links LOK from a distro package and modifies no upstream file**, the
obligations are modest:

1. **Preserve notices.** Ship LibreOffice's licence texts and copyright notices with any
   distribution that includes it (including container images).
2. **Source availability.** For MPL-covered code we distribute, make Source Code Form available.
   Pointing at the exact upstream version tag satisfies this while we ship it unmodified.
3. **Publish our modifications**, if we ever carry patches — under MPL-2.0, per file.
4. **Maintain `THIRD_PARTY_NOTICES.md`** enumerating every bundled component and its licence.
5. **Do not imply endorsement** by The Document Foundation.

---

## 4. Trademark — rebranding is required, not optional

"LibreOffice" and its logos are registered trademarks. The source licence grants **no** trademark
rights (MPL-2.0 §2.3 is explicit).

Therefore we **must**:
- ship under our own product name and our own icons/splash/About;
- not describe the product as "LibreOffice" or as an official TDF product;
- **may and should** state factual provenance, e.g.
  *"Built on LibreOffice technology. Not affiliated with or endorsed by The Document Foundation."*

Factual attribution is permitted and is also good practice. Implying affiliation is not.

**Practical note:** the working codename `mpw` and the existing directory name `libre_off` are
both unsuitable for release — `libre_off` in particular reads as a LibreOffice sub-brand and
should not be used publicly. Choose a distinct name before any public artifact.

---

## 5. Licence choice for our own code

| Option | Effect |
|---|---|
| **MPL-2.0** ← recommended | Same licence as upstream. No compatibility question ever arises; contributions can flow upstream cleanly; still permits commercial use. |
| Apache-2.0 / MIT | More permissive; compatible as a Larger Work, but creates a two-licence codebase to reason about. |
| GPLv3 | Viable, but forecloses options and complicates combination with Apache-2.0-derived parts. |

**Recommendation: MPL-2.0 for our code**, matching upstream. One licence across the tree, and
patches can be upstreamed without relicensing friction.

---

## 6. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| L1 | Shipping a container with LibreOffice but without licence texts/source offer | **High** — a real compliance breach, and easy to do by accident | Bake notices into the image at build time; make it a CI check, not a checklist item |
| L2 | Product name or icons implying TDF affiliation | **High** | §4; settle naming before any public artifact |
| L3 | Bundled third-party components with stricter licences than MPL | Medium | Generate `THIRD_PARTY_NOTICES.md` from the actual package manifest, not by hand |
| L4 | Patch series drifting undocumented | Medium | Every patch carries provenance + upstream bug link |
| L5 | **Audio/codec patents** — MP3/AAC decode via FFmpeg builds | Medium | Prefer WAV/FLAC/OGG for development; document the FFmpeg build actually shipped; MP3 is broadly patent-free since 2017 but AAC is not |
| L6 | Assuming rebranding removes open-source duties | **High if believed** | Explicitly false. §3 obligations persist regardless of branding |
| L7 | User-supplied music content (copyright) | Medium | Product plays local files the user supplies; ship no content; do not add acquisition/download features |

---

## 7. Actions before first public release

- [ ] Choose a product name that does not evoke LibreOffice; clear a basic trademark search
- [ ] `LICENSE` at repo root (MPL-2.0 recommended)
- [ ] `THIRD_PARTY_NOTICES.md`, generated from the shipped image's package manifest
- [ ] Licence texts + written source offer baked into the container image
- [ ] "Built on LibreOffice technology — not affiliated with TDF" in About and README
- [ ] Record the exact upstream version/commit shipped
- [ ] Counsel review if distribution goes beyond personal/home-lab use
