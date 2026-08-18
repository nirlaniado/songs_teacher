// mpw-host — the ONLY component that talks to LibreOffice.
//
// ADR-002 §3: this process owns document loading, rendering, slide
// manipulation and export. It owns nothing else. There is deliberately no
// timeline, transport, tempo or waveform code here, and there must never be —
// if a change needs C++ *and* touches timing, the boundary is wrong.
//
// Protocol (ADR-002 §4): line-delimited text on stdin/stdout, one message per
// line. A JSON parser would be more code than the messages.
//
//   OPEN <path>                                    -> OK <slideCount>
//   NAME <index>                                   -> OK <name>
//   RENDER <index> <w> <h> <outPath>               -> OK <outPath>
//   SAVEAS <format> <outPath>                      -> OK <outPath>
//   UNO <.uno:Command>                             -> OK <slideCount>
//   MOUSE <DOWN|UP|MOVE> <x> <y> <count> <buttons> <modifier>   -> OK
//   KEY <INPUT|UP> <charCode> <keyCode>            -> OK
//   SIZE                                           -> OK <docW> <docH>
//   QUIT                                           -> OK
//
// Errors are `ERR <message>`. Binary never crosses the pipe: renders are
// written to disk and the path returned, so the server can serve them over
// HTTP with ordinary caching.
//
// Events (Stage 1 addition): LOK callbacks — selection, cursor, invalidated
// tiles, uno command results — are not requested, they arrive as a side
// effect of MOUSE/KEY/UNO. They share the same stdout line stream, tagged so
// the server can tell them apart from a command's own response:
//
//   EVENT <TypeName> <payload>
//
// This works *because* the host is single-threaded and synchronous: a LOK
// callback registered via registerCallback fires re-entrantly, during the
// call that triggers it, on the same thread — so every EVENT line for a
// given command is written before that command's OK/ERR line, never after
// and never interleaved with a different command's events. The server can
// rely on that ordering instead of correlating events by id.

#define LOK_USE_UNSTABLE_API
#include <LibreOfficeKit/LibreOfficeKit.hxx>
#include <LibreOfficeKit/LibreOfficeKitEnums.h>

#include <zlib.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

lok::Office*   g_office = nullptr;
lok::Document* g_doc    = nullptr;
long           g_docW   = 0;
long           g_docH   = 0;

void ok(const std::string& payload = "") {
    std::cout << "OK" << (payload.empty() ? "" : " " + payload) << std::endl;
}
void err(const std::string& message) {
    std::cout << "ERR " << message << std::endl;
}

// ---------------------------------------------------------------------------
// Event channel. Same symbolic-constant approach as lok/poc/probe.cpp's
// callbackTypeName — matched by name, not a hardcoded integer, so this stays
// correct even if a LibreOffice version renumbers the underlying values.
// ---------------------------------------------------------------------------

std::string callbackTypeName(int nType) {
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
        default: return "UNKNOWN_" + std::to_string(nType);
    }
}

// Payloads observed in Stage 0 are single-line (JSON objects for the
// UNO/STATE types, plain comma-separated numbers for tile/cursor rects).
// A literal newline inside a payload would break the line protocol; replaced
// rather than trusted, since a malformed line is worse than a mangled one.
void lokCallback(int nType, const char* pPayload, void*) {
    std::string payload = pPayload ? pPayload : "";
    for (char& c : payload) if (c == '\n' || c == '\r') c = ' ';
    std::cout << "EVENT " << callbackTypeName(nType)
               << (payload.empty() ? "" : " " + payload) << std::endl;
}

// ---------------------------------------------------------------------------
// PNG encoding. zlib only — pulling in libpng for one call would be a
// dependency we'd carry forever for ~50 lines of well-specified format.
// ---------------------------------------------------------------------------

void be32(std::vector<unsigned char>& out, unsigned v) {
    out.push_back((v >> 24) & 0xFF); out.push_back((v >> 16) & 0xFF);
    out.push_back((v >> 8) & 0xFF);  out.push_back(v & 0xFF);
}

void chunk(std::vector<unsigned char>& out, const char tag[4],
           const std::vector<unsigned char>& data) {
    be32(out, static_cast<unsigned>(data.size()));
    std::vector<unsigned char> body(tag, tag + 4);
    body.insert(body.end(), data.begin(), data.end());
    out.insert(out.end(), body.begin(), body.end());
    be32(out, static_cast<unsigned>(crc32(0, body.data(),
                                          static_cast<unsigned>(body.size()))));
}

/// LOK hands back BGRA; PNG wants RGB. Alpha is dropped: a slide is opaque.
bool writePNG(const std::string& path, const unsigned char* bgra, int w, int h) {
    std::vector<unsigned char> raw;
    raw.reserve(static_cast<size_t>(h) * (1 + w * 3));
    for (int y = 0; y < h; ++y) {
        raw.push_back(0);                        // filter type 0 (None)
        const unsigned char* row = bgra + static_cast<size_t>(y) * w * 4;
        for (int x = 0; x < w; ++x) {
            raw.push_back(row[x * 4 + 2]);       // R
            raw.push_back(row[x * 4 + 1]);       // G
            raw.push_back(row[x * 4 + 0]);       // B
        }
    }

    uLongf zlen = compressBound(static_cast<uLong>(raw.size()));
    std::vector<unsigned char> z(zlen);
    if (compress2(z.data(), &zlen, raw.data(),
                  static_cast<uLong>(raw.size()), 6) != Z_OK) return false;
    z.resize(zlen);

    std::vector<unsigned char> png = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    std::vector<unsigned char> ihdr;
    be32(ihdr, static_cast<unsigned>(w));
    be32(ihdr, static_cast<unsigned>(h));
    ihdr.push_back(8);                            // bit depth
    ihdr.push_back(2);                            // colour type 2 = truecolour
    ihdr.insert(ihdr.end(), {0, 0, 0});           // deflate/adaptive/no interlace
    chunk(png, "IHDR", ihdr);
    chunk(png, "IDAT", z);
    chunk(png, "IEND", {});

    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    std::fwrite(png.data(), 1, png.size(), f);
    std::fclose(f);
    return true;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

void cmdOpen(const std::string& path) {
    if (g_doc) { delete g_doc; g_doc = nullptr; }

    // "private:factory/simpress" (new blank presentation) is already a
    // complete LO-internal URL, not a filesystem path — only bare paths get
    // file:// prepended.
    const bool alreadyUrl = path.rfind("file://", 0) == 0 || path.rfind("private:", 0) == 0;
    const std::string url = alreadyUrl ? path : "file://" + path;
    g_doc = g_office->documentLoad(url.c_str());
    if (!g_doc) {
        char* e = g_office->getError();
        err(e && *e ? e : "documentLoad failed");
        return;
    }

    // Verified in LOK_CAPABILITY_MATRIX.md §2: without this, every UNO command
    // silently no-ops — no error, no callback. Non-negotiable.
    g_doc->initializeForRendering("{}");
    g_doc->getDocumentSize(&g_docW, &g_docH);

    // registerCallback is per-document, not per-Office — must be redone
    // against the new document every OPEN, not just once in main().
    g_doc->registerCallback(lokCallback, nullptr);

    // Stage 0 finding (LOK_CAPABILITY_MATRIX.md §3): against 24.2,
    // initializeForRendering() alone leaves the page/slide command dispatch
    // table unwired — every .uno: command silently no-ops until one tile has
    // actually been painted. One throwaway render here, and every UNO/MOUSE/
    // KEY command that follows behaves correctly instead of failing silently
    // on whichever one happens to run first.
    std::vector<unsigned char> warm(static_cast<size_t>(960) * 540 * 4, 0);
    g_doc->paintTile(warm.data(), 960, 540, 0, 0, g_docW, g_docH);

    ok(std::to_string(g_doc->getParts()));
}

void cmdRender(int index, int w, int h, const std::string& out) {
    if (!g_doc)             { err("no document open"); return; }
    if (w <= 0 || h <= 0)   { err("bad dimensions"); return; }
    if (index < 0 || index >= g_doc->getParts()) { err("slide index out of range"); return; }

    g_doc->setPart(index);
    std::vector<unsigned char> buf(static_cast<size_t>(w) * h * 4, 0);
    g_doc->paintTile(buf.data(), w, h, 0, 0, g_docW, g_docH);

    if (!writePNG(out, buf.data(), w, h)) { err("png write failed: " + out); return; }
    ok(out);
}

void cmdSize() {
    if (!g_doc) { err("no document open"); return; }
    ok(std::to_string(g_docW) + " " + std::to_string(g_docH));
}

void cmdName(int index) {
    if (!g_doc) { err("no document open"); return; }
    char* n = g_doc->getPartName(index);
    if (!n) { err("no such slide"); return; }
    ok(n);
    std::free(n);
}

void cmdSaveAs(const std::string& format, const std::string& out) {
    if (!g_doc) { err("no document open"); return; }
    const std::string url = out.rfind("file://", 0) == 0 ? out : "file://" + out;
    g_doc->saveAs(url.c_str(), format.c_str(), nullptr) ? ok(out) : err("saveAs failed");
}

void cmdUno(const std::string& command) {
    if (!g_doc) { err("no document open"); return; }
    // bNotifyWhenFinished MUST be true. False dispatches asynchronously with
    // no synchronous settlement point — getParts() read immediately after
    // then observes stale state, off by exactly one command (measured: two
    // DuplicatePage calls in a row reported "1, 2" instead of "2, 3", the
    // first call's effect only visible once the second had already fired).
    // True blocks until the command actually completes, matching what
    // lok/poc/probe.cpp used throughout Stage 0.
    g_doc->postUnoCommand(command.c_str(), nullptr, true);
    // The callback's `success` flag is unreliable (LOK_CAPABILITY_MATRIX §2 —
    // .uno:DeletePage reports false while actually deleting), so report the
    // observable state instead and let the caller decide.
    ok(std::to_string(g_doc->getParts()));
}

void cmdMouse(const std::string& type, int x, int y, int count, int buttons, int modifier) {
    if (!g_doc) { err("no document open"); return; }
    int nType;
    if (type == "DOWN")      nType = LOK_MOUSEEVENT_MOUSEBUTTONDOWN;
    else if (type == "UP")   nType = LOK_MOUSEEVENT_MOUSEBUTTONUP;
    else if (type == "MOVE") nType = LOK_MOUSEEVENT_MOUSEMOVE;
    else { err("unknown mouse type: " + type); return; }

    g_doc->postMouseEvent(nType, x, y, count, buttons, modifier);
    ok();
}

void cmdKey(const std::string& type, int charCode, int keyCode) {
    if (!g_doc) { err("no document open"); return; }
    int nType;
    if (type == "INPUT")    nType = LOK_KEYEVENT_KEYINPUT;
    else if (type == "UP")  nType = LOK_KEYEVENT_KEYUP;
    else { err("unknown key type: " + type); return; }

    g_doc->postKeyEvent(nType, charCode, keyCode);
    ok();
}

}  // namespace

int main(int argc, char** argv) {
    const char* loPath = (argc > 1) ? argv[1] : "/home/nir20/guitar_teacher/lo-clean-build/instdir/program";

    g_office = lok::lok_cpp_init(loPath);
    if (!g_office) {
        std::cout << "ERR cannot initialise LibreOfficeKit at " << loPath << std::endl;
        return 1;
    }
    std::cout << "READY" << std::endl;

    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string verb;
        in >> verb;

        if (verb == "OPEN") {
            std::string p; std::getline(in >> std::ws, p); cmdOpen(p);
        } else if (verb == "RENDER") {
            int i, w, h; std::string out;
            in >> i >> w >> h; std::getline(in >> std::ws, out);
            cmdRender(i, w, h, out);
        } else if (verb == "NAME") {
            int i; in >> i; cmdName(i);
        } else if (verb == "SAVEAS") {
            std::string fmt, out; in >> fmt; std::getline(in >> std::ws, out);
            cmdSaveAs(fmt, out);
        } else if (verb == "UNO") {
            std::string c; std::getline(in >> std::ws, c); cmdUno(c);
        } else if (verb == "MOUSE") {
            std::string type; int x, y, count, buttons, modifier;
            in >> type >> x >> y >> count >> buttons >> modifier;
            cmdMouse(type, x, y, count, buttons, modifier);
        } else if (verb == "KEY") {
            std::string type; int charCode, keyCode;
            in >> type >> charCode >> keyCode;
            cmdKey(type, charCode, keyCode);
        } else if (verb == "SIZE") {
            cmdSize();
        } else if (verb == "QUIT") {
            ok(); break;
        } else if (!verb.empty()) {
            err("unknown verb: " + verb);
        }
    }

    delete g_doc;
    return 0;
}
