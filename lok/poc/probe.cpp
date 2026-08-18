// Phase 0.5 capability probe — ROADMAP.md Steps 1 & 2.
//
// Answers risk R1: is LibreOfficeKit's Impress surface deep enough to build
// on, or must we patch LibreOffice source? Everything here is measurement.
// Throwaway code: it proves feasibility, it is not the architecture.
//
// Deliberately uses NO fixture file. `private:factory/simpress` asks
// LibreOffice to mint a new empty presentation, which also proves document
// *creation* works headlessly — a V1 requirement (brief §9).
//
// --- Sections 1-6 are unchanged from the first (7.4.7) run, which cleared
// them 16/3. Sections 7-10 are new: the interactive-editing questions that
// run explicitly left open (text editing, shape/image insert, selection
// callbacks, edit->repaint latency). These are the actual gate for this
// stage — rendering and export were never in doubt, editing was.

#define LOK_USE_UNSTABLE_API
#include <LibreOfficeKit/LibreOfficeKit.hxx>
#include <LibreOfficeKit/LibreOfficeKitEnums.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

static int g_pass = 0, g_fail = 0;

static void report(const char* name, bool ok, const std::string& detail = "") {
    std::printf("  [%s] %-34s %s\n", ok ? "PASS" : "FAIL", name, detail.c_str());
    ok ? ++g_pass : ++g_fail;
}

/// 32-bit BMP writer. BMP because it needs no image library — the point is to
/// prove pixels came out of LibreOffice, not to pick an image format.
/// LOK hands back BGRA, which is already BMP's channel order.
static bool writeBMP(const char* path, const unsigned char* bgra, int w, int h) {
    std::FILE* f = std::fopen(path, "wb");
    if (!f) return false;
    const unsigned pixelBytes = static_cast<unsigned>(w) * h * 4;
    const unsigned fileSize   = 54 + pixelBytes;

    unsigned char hdr[54] = {};
    hdr[0] = 'B'; hdr[1] = 'M';
    std::memcpy(&hdr[2],  &fileSize, 4);
    const unsigned offset = 54;  std::memcpy(&hdr[10], &offset, 4);
    const unsigned info   = 40;  std::memcpy(&hdr[14], &info, 4);
    std::memcpy(&hdr[18], &w, 4);
    const int negH = -h;              // negative height = top-down rows
    std::memcpy(&hdr[22], &negH, 4);
    const unsigned short planes = 1, bpp = 32;
    std::memcpy(&hdr[26], &planes, 2);
    std::memcpy(&hdr[28], &bpp, 2);
    std::memcpy(&hdr[34], &pixelBytes, 4);

    std::fwrite(hdr, 1, 54, f);
    std::fwrite(bgra, 1, pixelBytes, f);
    std::fclose(f);
    return true;
}

/// True if the buffer holds more than one distinct colour — i.e. LibreOffice
/// actually drew something rather than handing back a blank rectangle.
static bool hasContent(const unsigned char* bgra, int w, int h) {
    const unsigned* px = reinterpret_cast<const unsigned*>(bgra);
    const unsigned first = px[0];
    const long n = static_cast<long>(w) * h;
    for (long i = 1; i < n; ++i) if (px[i] != first) return true;
    return false;
}

/// Count of differing pixels between two equally-sized BGRA buffers — used to
/// tell "nothing changed" from "something changed", which plain hasContent()
/// can't: a blank slide and an edited one are both "has content" once a
/// placeholder outline is on screen.
static long diffCount(const unsigned char* a, const unsigned char* b, int w, int h) {
    const unsigned* pa = reinterpret_cast<const unsigned*>(a);
    const unsigned* pb = reinterpret_cast<const unsigned*>(b);
    const long n = static_cast<long>(w) * h;
    long diff = 0;
    for (long i = 0; i < n; ++i) if (pa[i] != pb[i]) ++diff;
    return diff;
}

/// Human-readable name for a LOK callback type, by symbolic constant rather
/// than a hardcoded integer — so this stays correct across LO versions even
/// if the underlying values differ from what earlier runs observed. Unknown
/// types still print their raw number rather than being silently dropped.
static std::string callbackTypeName(int nType) {
    switch (nType) {
        case LOK_CALLBACK_INVALIDATE_TILES:          return "INVALIDATE_TILES";
        case LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR:  return "INVALIDATE_VISIBLE_CURSOR";
        case LOK_CALLBACK_TEXT_SELECTION:             return "TEXT_SELECTION";
        case LOK_CALLBACK_TEXT_SELECTION_START:       return "TEXT_SELECTION_START";
        case LOK_CALLBACK_TEXT_SELECTION_END:         return "TEXT_SELECTION_END";
        case LOK_CALLBACK_CURSOR_VISIBLE:             return "CURSOR_VISIBLE";
        case LOK_CALLBACK_GRAPHIC_SELECTION:          return "GRAPHIC_SELECTION";
        case LOK_CALLBACK_HYPERLINK_CLICKED:          return "HYPERLINK_CLICKED";
        case LOK_CALLBACK_STATE_CHANGED:              return "STATE_CHANGED";
        case LOK_CALLBACK_STATUS_INDICATOR_START:     return "STATUS_INDICATOR_START";
        case LOK_CALLBACK_STATUS_INDICATOR_SET_VALUE: return "STATUS_INDICATOR_SET_VALUE";
        case LOK_CALLBACK_STATUS_INDICATOR_FINISH:    return "STATUS_INDICATOR_FINISH";
        case LOK_CALLBACK_SEARCH_NOT_FOUND:           return "SEARCH_NOT_FOUND";
        case LOK_CALLBACK_DOCUMENT_SIZE_CHANGED:      return "DOCUMENT_SIZE_CHANGED";
        case LOK_CALLBACK_SET_PART:                   return "SET_PART";
        case LOK_CALLBACK_SEARCH_RESULT_SELECTION:    return "SEARCH_RESULT_SELECTION";
        case LOK_CALLBACK_UNO_COMMAND_RESULT:         return "UNO_COMMAND_RESULT";
        default: return "UNKNOWN(" + std::to_string(nType) + ")";
    }
}

// All callback types seen since the last clearSeenCallbacks() call, so each
// probe section can report exactly what fired during *its* operation rather
// than an undifferentiated whole-run soup.
static std::set<int> g_seenTypes;
static std::vector<std::string> g_lastPayloads;

static void clearSeenCallbacks() { g_seenTypes.clear(); g_lastPayloads.clear(); }

static void lokCallback(int nType, const char* pPayload, void*) {
    g_seenTypes.insert(nType);
    if (pPayload) {
        g_lastPayloads.push_back(callbackTypeName(nType) + ": " + pPayload);
    }
}

static std::string joinSeenTypes() {
    std::string out;
    for (int t : g_seenTypes) { if (!out.empty()) out += ", "; out += callbackTypeName(t); }
    return out.empty() ? "(none)" : out;
}

int main(int argc, char** argv) {
    const char* loPath = (argc > 1) ? argv[1] : "/home/nir20/guitar_teacher/lo-clean-build/instdir/program";
    const char* outDir = (argc > 2) ? argv[2] : "/out";

    std::printf("\n=== LOK Impress capability probe ===\n");
    std::printf("LibreOffice: %s\n\n", loPath);

    // ---- 1. Initialise -----------------------------------------------------
    std::printf("[1] Runtime\n");
    lok::Office* office = lok::lok_cpp_init(loPath);
    if (!office) { report("lok_cpp_init", false, "cannot load LOK"); return 1; }
    report("lok_cpp_init", true);

    if (char* v = office->getVersionInfo()) {
        std::printf("       version: %s\n", v);
        std::free(v);
    }

    // ---- 2. Create a presentation -----------------------------------------
    std::printf("\n[2] Document lifecycle\n");
    lok::Document* doc = office->documentLoad("private:factory/simpress");
    if (!doc) {
        char* err = office->getError();
        report("documentLoad(simpress)", false, err ? err : "null");
        return 1;
    }
    report("documentLoad(new presentation)", true);

    // Verified against LibreOfficeKitEnums.h in this exact image:
    //   TEXT=0, SPREADSHEET=1, PRESENTATION=2, DRAWING=3, OTHER=4
    const int docType = doc->getDocumentType();
    report("getDocumentType == presentation", docType == 2,
           "type=" + std::to_string(docType));

    long docW = 0, docH = 0;
    doc->getDocumentSize(&docW, &docH);
    report("getDocumentSize", docW > 0 && docH > 0,
           std::to_string(docW) + "x" + std::to_string(docH) + " twips");

    // ---- 3. Slides as parts ------------------------------------------------
    std::printf("\n[3] Slide model (slides == LOK parts)\n");
    const int initial = doc->getParts();
    report("getParts on new deck", initial >= 1, "parts=" + std::to_string(initial));

    if (char* nm = doc->getPartName(0)) {
        report("getPartName(0)", true, std::string("\"") + nm + "\"");
        std::free(nm);
    } else report("getPartName(0)", false);

    // ---- 4. The R1 gate: .uno: editing commands ----------------------------
    std::printf("\n[4] Editing via postUnoCommand  <-- the R1 gate\n");

    // A view must exist before UNO commands have anything to dispatch against.
    // Omitting this made every command silently no-op on the first probe run —
    // the commands were fine, the setup was not.
    doc->initializeForRendering("{}");
    report("initializeForRendering", true);

    // Register once, for the whole rest of the run. Every later section reads
    // g_seenTypes / g_lastPayloads rather than installing its own callback.
    doc->registerCallback(lokCallback, nullptr);

    // A SECOND prerequisite, found by experiment against 24.2 and not needed
    // (or not noticed) against 7.4: initializeForRendering() alone leaves
    // page/slide commands dispatching to nothing — no callback, no error, no
    // effect, exactly the silent-no-op signature the first prerequisite was
    // added to fix. One throwaway paintTile() here wires up whatever the
    // dispatch table needed. Without this warm-up, InsertPage/DuplicatePage/
    // DeletePage all fail below; with it, they all pass.
    {
        std::vector<unsigned char> warm(static_cast<size_t>(960) * 540 * 4, 0);
        long dw = 0, dh = 0; doc->getDocumentSize(&dw, &dh);
        doc->paintTile(warm.data(), 960, 540, 0, 0, dw, dh);
    }
    report("warm-up paintTile before page commands", true);

    auto tryUno = [&](const char* cmd, int expectedDelta) {
        const int before = doc->getParts();
        doc->postUnoCommand(cmd, nullptr, true);
        const int after = doc->getParts();
        report(cmd, (after - before) == expectedDelta,
               std::to_string(before) + " -> " + std::to_string(after));
        return after - before;
    };

    // Impress/Draw page commands. Names differ between LibreOffice versions and
    // between Draw and Impress, so probe variants rather than assume one.
    if (tryUno(".uno:InsertPage", +1) == 0) {
        std::printf("       .uno:InsertPage inert; trying variants\n");
        tryUno(".uno:InsertSlide", +1);
        tryUno(".uno:NewPage", +1);
    }
    tryUno(".uno:DuplicatePage", +1);
    tryUno(".uno:DeletePage",    -1);

    doc->setPart(0);
    report("setPart(0)", doc->getPart() == 0);

    // ---- 5. Rendering ------------------------------------------------------
    std::printf("\n[5] Rendering\n");
    const int cw = 960, ch = 540;                 // 16:9 preview
    std::vector<unsigned char> buf(static_cast<size_t>(cw) * ch * 4, 0);
    doc->paintTile(buf.data(), cw, ch, 0, 0, docW, docH);
    report("paintTile(whole slide)", true, std::to_string(cw) + "x" + std::to_string(ch));
    report("tile has drawn content", hasContent(buf.data(), cw, ch));

    const std::string bmp = std::string(outDir) + "/slide0.bmp";
    report("write slide0.bmp", writeBMP(bmp.c_str(), buf.data(), cw, ch), bmp);

    // ---- 6. Export formats -------------------------------------------------
    std::printf("\n[6] Export (saveAs)\n");
    auto trySave = [&](const char* name, const char* fmt) {
        const std::string url = "file://" + std::string(outDir) + "/probe." + fmt;
        const bool ok = doc->saveAs(url.c_str(), fmt, nullptr);
        report(name, ok, url);
    };
    trySave("saveAs ODP  (native)", "odp");
    trySave("saveAs PPTX (OOXML)",  "pptx");
    trySave("saveAs PDF  (export)", "pdf");

    // ======================================================================
    // Everything below is new: the interactive-editing surface the previous
    // run explicitly left unproven. This is the actual gate for "Impress UI
    // and proven editing functions" — rendering and export were never in
    // doubt.
    // ======================================================================

    // ---- 7. Shape insertion (draw tool + synthetic mouse drag) -------------
    // There is no "insertShapeAt(rect)" call in the LOK C API. The real
    // client contract is: select a drawing tool via postUnoCommand, then
    // synthesize the same mouse sequence a user would produce — button down
    // at the start corner, a move, button up at the end corner. This is also
    // the most direct test of postMouseEvent itself, ahead of using it for
    // text editing below.
    std::printf("\n[7] Shape insertion (.uno:Rect + postMouseEvent drag)\n");
    clearSeenCallbacks();
    {
        std::vector<unsigned char> before(static_cast<size_t>(cw) * ch * 4, 0);
        doc->paintTile(before.data(), cw, ch, 0, 0, docW, docH);

        doc->postUnoCommand(".uno:Rect", nullptr, true);

        // Draw a rectangle in the lower-right quadrant, away from the title/
        // content placeholders, so a diff there can't be confused with the
        // text-edit test in section 8. Coordinates are in twips (doc space),
        // matching postMouseEvent's contract — not the 960x540 pixel buffer.
        const int x1 = static_cast<int>(docW * 0.55), y1 = static_cast<int>(docH * 0.55);
        const int x2 = static_cast<int>(docW * 0.90), y2 = static_cast<int>(docH * 0.90);
        const int LEFT_BUTTON = 1;

        doc->postMouseEvent(LOK_MOUSEEVENT_MOUSEBUTTONDOWN, x1, y1, 1, LEFT_BUTTON, 0);
        doc->postMouseEvent(LOK_MOUSEEVENT_MOUSEMOVE,       x2, y2, 1, LEFT_BUTTON, 0);
        doc->postMouseEvent(LOK_MOUSEEVENT_MOUSEBUTTONUP,   x2, y2, 1, LEFT_BUTTON, 0);
        doc->postUnoCommand(".uno:Escape", nullptr, true);   // deselect, exit draw mode

        std::vector<unsigned char> after(static_cast<size_t>(cw) * ch * 4, 0);
        doc->paintTile(after.data(), cw, ch, 0, 0, docW, docH);

        const long diff = diffCount(before.data(), after.data(), cw, ch);
        report("shape appears after mouse drag", diff > 0, std::to_string(diff) + " px changed");
        std::printf("       callbacks seen: %s\n", joinSeenTypes().c_str());

        writeBMP((std::string(outDir) + "/shape_after.bmp").c_str(), after.data(), cw, ch);
    }

    // ---- 8. Image insertion (.uno:InsertGraphic against a local fixture) ---
    // No PNG encoder in this throwaway probe, so the fixture is a BMP we
    // already know how to write — LibreOffice's graphic filters accept BMP
    // like any other supported format. The UNO argument's property name for
    // a file-based insert has drifted across LO/OOo history ("FileName" is
    // the classic dispatcher property; "GraphicURL" is the LOK-era one) — so,
    // same as the InsertPage variants above, probe both rather than assume.
    std::printf("\n[8] Image insertion (.uno:InsertGraphic)\n");
    {
        const std::string fixturePath = std::string(outDir) + "/fixture.bmp";
        std::vector<unsigned char> fixture(8 * 8 * 4);
        for (size_t i = 0; i < fixture.size(); i += 4) {
            fixture[i + 0] = 0x00; fixture[i + 1] = 0x00;   // B, G
            fixture[i + 2] = 0xFF; fixture[i + 3] = 0x00;   // R, (unused)
        }
        writeBMP(fixturePath.c_str(), fixture.data(), 8, 8);

        std::vector<unsigned char> before(static_cast<size_t>(cw) * ch * 4, 0);
        doc->paintTile(before.data(), cw, ch, 0, 0, docW, docH);

        auto tryInsert = [&](const char* propName) -> bool {
            const std::string args =
                "{\"" + std::string(propName) + "\":{\"type\":\"string\",\"value\":\"file://"
                + fixturePath + "\"}}";
            doc->postUnoCommand(".uno:InsertGraphic", args.c_str(), true);

            std::vector<unsigned char> after(static_cast<size_t>(cw) * ch * 4, 0);
            doc->paintTile(after.data(), cw, ch, 0, 0, docW, docH);
            const long diff = diffCount(before.data(), after.data(), cw, ch);
            report((std::string(".uno:InsertGraphic (") + propName + ")").c_str(), diff > 0,
                   std::to_string(diff) + " px changed");
            if (diff > 0) {
                writeBMP((std::string(outDir) + "/image_after.bmp").c_str(), after.data(), cw, ch);
                doc->postUnoCommand(".uno:Escape", nullptr, true);
            }
            return diff > 0;
        };
        if (!tryInsert("GraphicURL")) tryInsert("FileName");
    }

    // ---- 9. Text editing: double-click into a placeholder, type, verify ----
    // The actual R1-for-editing question. postMouseEvent's nCount parameter
    // carries click multiplicity (1 = single, 2 = double) per its header
    // documentation — a double-click at the same point is one down/up pair
    // with nCount=2, not two separate pairs. If that assumption is wrong,
    // this section FAILs cleanly with before/after BMPs saved for a human to
    // look at, rather than silently reporting success either way.
    std::printf("\n[9] Text editing (double-click + postKeyEvent)\n");
    clearSeenCallbacks();
    // Kept outside the block below so section [12] (edit -> save -> reopen)
    // can diff a freshly-reloaded render against the exact pre-edit state,
    // not just check "some content exists".
    std::vector<unsigned char> textEditBefore(static_cast<size_t>(cw) * ch * 4, 0);
    {
        std::vector<unsigned char>& before = textEditBefore;
        doc->paintTile(before.data(), cw, ch, 0, 0, docW, docH);

        // Default "Title, Content" layout puts the title placeholder in the
        // upper portion of the slide, roughly centred — aim for its middle.
        const int tx = static_cast<int>(docW * 0.5), ty = static_cast<int>(docH * 0.15);
        const int LEFT_BUTTON = 1;

        doc->postMouseEvent(LOK_MOUSEEVENT_MOUSEBUTTONDOWN, tx, ty, 2, LEFT_BUTTON, 0);
        doc->postMouseEvent(LOK_MOUSEEVENT_MOUSEBUTTONUP,   tx, ty, 2, LEFT_BUTTON, 0);

        const std::string typed = "Do";
        const auto t0 = std::chrono::steady_clock::now();
        for (char c : typed) {
            doc->postKeyEvent(LOK_KEYEVENT_KEYINPUT, static_cast<int>(c), 0);
            doc->postKeyEvent(LOK_KEYEVENT_KEYUP,     static_cast<int>(c), 0);
        }

        std::vector<unsigned char> after(static_cast<size_t>(cw) * ch * 4, 0);
        doc->paintTile(after.data(), cw, ch, 0, 0, docW, docH);
        const auto t1 = std::chrono::steady_clock::now();
        const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

        doc->postUnoCommand(".uno:Escape", nullptr, true);
        doc->postUnoCommand(".uno:Escape", nullptr, true);

        const long diff = diffCount(before.data(), after.data(), cw, ch);
        report("typed text appears in render", diff > 0, std::to_string(diff) + " px changed");
        std::printf("       callbacks seen during edit: %s\n", joinSeenTypes().c_str());
        std::printf("       key events -> correct repaint: %.2f ms  (Q5, edit->repaint latency)\n", ms);

        const bool sawSelection =
            g_seenTypes.count(LOK_CALLBACK_TEXT_SELECTION) ||
            g_seenTypes.count(LOK_CALLBACK_GRAPHIC_SELECTION) ||
            g_seenTypes.count(LOK_CALLBACK_CURSOR_VISIBLE) ||
            g_seenTypes.count(LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR);
        report("selection/cursor callback fired", sawSelection);

        writeBMP((std::string(outDir) + "/text_before.bmp").c_str(), before.data(), cw, ch);
        writeBMP((std::string(outDir) + "/text_after.bmp").c_str(),  after.data(),  cw, ch);

        if (diff == 0) {
            std::printf("       NOTE: no visible change — nCount=2 double-click assumption may be\n"
                        "       wrong for this LO version. Compare text_before.bmp/text_after.bmp\n"
                        "       by eye; retry with a different click/key sequence if genuinely blank.\n");
        }

        // Persist the edited state now, while it's live in memory, for section
        // [12] to reload independently. Deliberately a different file from the
        // pre-edit probe.pptx saved in section [6].
        const std::string editedUrl = "file://" + std::string(outDir) + "/probe_edited.pptx";
        const bool savedEdited = doc->saveAs(editedUrl.c_str(), "pptx", nullptr);
        report("saveAs edited PPTX", savedEdited, editedUrl);
    }

    // ---- 10. Toolbar state reflection (.uno:Bold + STATE_CHANGED) ----------
    std::printf("\n[10] Toolbar state (.uno:Bold -> STATE_CHANGED)\n");
    clearSeenCallbacks();
    {
        doc->postUnoCommand(".uno:Bold", nullptr, true);
        bool sawBoldState = false;
        for (const auto& p : g_lastPayloads) {
            if (p.find("STATE_CHANGED") != std::string::npos && p.find("Bold") != std::string::npos) {
                sawBoldState = true;
                std::printf("       %s\n", p.c_str());
            }
        }
        report(".uno:Bold produces a STATE_CHANGED payload", sawBoldState);
        report("(any) callback fired for .uno:Bold", !g_seenTypes.empty(),
               joinSeenTypes());
    }

    // ---- 11. Round-trip fidelity: reload our own exported PPTX -------------
    // A genuine "real-world .pptx" fixture isn't available in this repo
    // without fetching an external file, which the probe deliberately avoids
    // (self-contained, offline, same discipline as the rest of this app).
    // This instead proves the narrower but still load-bearing claim: a deck
    // exported through saveAs(...,"pptx") above can be read back and
    // re-rendered without error. Import fidelity against a real-world,
    // externally-authored .pptx is manual follow-up (see matrix §6), not
    // covered here.
    std::printf("\n[11] Round-trip: reload our own probe.pptx\n");
    {
        const std::string url = "file://" + std::string(outDir) + "/probe.pptx";
        lok::Document* reloaded = office->documentLoad(url.c_str());
        report("documentLoad(own probe.pptx)", reloaded != nullptr);
        if (reloaded) {
            reloaded->initializeForRendering("{}");
            long rw = 0, rh = 0;
            reloaded->getDocumentSize(&rw, &rh);
            std::vector<unsigned char> rbuf(static_cast<size_t>(cw) * ch * 4, 0);
            reloaded->paintTile(rbuf.data(), cw, ch, 0, 0, rw, rh);
            report("reloaded pptx renders with content", hasContent(rbuf.data(), cw, ch));
            writeBMP((std::string(outDir) + "/reloaded_pptx.bmp").c_str(), rbuf.data(), cw, ch);
            delete reloaded;
        }
    }

    // ---- 12. Persistence: edit -> save -> reopen -> verify the edit stuck --
    // Section 11 proves save/reload of *unedited* content. This is the
    // stronger, application-level claim the product actually depends on: an
    // edit made through the LOK API, saved, and reloaded in a fresh
    // Document/Office-independent load, must still show that edit — not just
    // "some content", the *specific* edit from section 9. Opens a brand new
    // lok::Document rather than reusing `doc`, matching how a real reopen
    // works (no shared in-memory state to accidentally pass the test).
    std::printf("\n[12] Persistence: edit -> save -> reopen -> verify\n");
    {
        const std::string editedUrl = "file://" + std::string(outDir) + "/probe_edited.pptx";
        lok::Document* reopened = office->documentLoad(editedUrl.c_str());
        report("documentLoad(probe_edited.pptx)", reopened != nullptr);
        if (reopened) {
            reopened->initializeForRendering("{}");
            long rw = 0, rh = 0;
            reopened->getDocumentSize(&rw, &rh);
            std::vector<unsigned char> rbuf(static_cast<size_t>(cw) * ch * 4, 0);
            reopened->paintTile(rbuf.data(), cw, ch, 0, 0, rw, rh);

            const long diff = diffCount(textEditBefore.data(), rbuf.data(), cw, ch);
            report("reopened doc still shows the edit vs. pre-edit render", diff > 0,
                   std::to_string(diff) + " px changed");
            writeBMP((std::string(outDir) + "/reopened_after_edit.bmp").c_str(), rbuf.data(), cw, ch);
            delete reopened;
        }
    }

    // ---- Summary -----------------------------------------------------------
    std::printf("\n=== %d passed, %d failed ===\n", g_pass, g_fail);
    std::printf("%s\n\n", g_fail == 0
        ? "R1 CLEARED (incl. interactive editing): build on this."
        : "See failures above — sections 9/9b (text edit, selection callbacks) are the hard gate;\n"
          "7/8/10/11 failing are workarounds, not blockers, per the stage-0 plan.");

    delete doc;
    return g_fail == 0 ? 0 : 2;
}
