/**
 * mpw-server — orchestration, project state, HTTP + WebSocket API (ADR-002 §3).
 *
 * Node stdlib plus `ws`. Stage 1 scope only: host supervision, project.json,
 * slide PNGs over HTTP, LOK callbacks over WebSocket. There is no frontend
 * served from here — Stage 2 adds a LOK-backed canvas *inside* the existing
 * React app (`npm run dev`), not a second, parallel frontend, so this server
 * is a pure API the existing app will fetch/connect against once that lands.
 *
 * Also no Docker: `HOST_CMD`/`HOST_ARGS` default to the native binary built
 * by `npm run lok:host:build`. Containerizing is deferred to packaging time
 * (agreed when Stage 0 started) — this is the whole reason `docker run …`
 * path-mapping (`/fx`, `/cache`) from the archived version is gone; native
 * paths are just paths.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { readFile, mkdir, rename, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";

import { LokHost, type HostEvent } from "./host.js";
import {
  load as loadProject,
  save as saveProject,
  newProject,
  slideAt,
  validateCues,
  type Project,
} from "./project.js";

const PORT = Number(process.env.API_PORT ?? 8091);
const PROJECT_DIR = resolve(process.env.PROJECT_DIR ?? "lok/server/fixtures");
const CACHE_DIR = resolve(process.env.CACHE_DIR ?? "lok/server/cache");
const SLIDE_W = Number(process.env.SLIDE_W ?? 1280);
const SLIDE_H = Number(process.env.SLIDE_H ?? 720);

const HOST_CMD = process.env.HOST_CMD ?? resolve("lok/host/mpw-host");
const HOST_ARGS = (process.env.HOST_ARGS ?? "/home/nir20/guitar_teacher/lo-clean-build/instdir/program").split(" ");

const host = new LokHost({ command: HOST_CMD, args: HOST_ARGS, requestTimeoutMs: 30_000 });

interface State {
  project: Project;
  slideCount: number;
  slideNames: string[];
  /** Twips — the canvas's coordinate-conversion input, NOT `slideSize`
   *  below (which is the render PNG's pixel size). Constant for the
   *  document's lifetime, so fetched once on open rather than per slide. */
  docSizeTwips: { w: number; h: number };
  /** Cache-buster per slide, bumped on edit so a re-render is never stale. */
  revision: number[];
}
let state: State | null = null;

async function openProject(): Promise<State> {
  await mkdir(PROJECT_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  let project: Project;
  try {
    project = await loadProject(PROJECT_DIR);
  } catch {
    // First run, no project.json yet: open a blank presentation rather than
    // requiring a checked-in .odp/.wav fixture that doesn't exist for this
    // stage — same "no fixture file" reasoning as lok/poc/probe.cpp.
    project = newProject("private:factory/simpress", null);
    await saveProject(PROJECT_DIR, project);
  }

  const slideCount = await host.open(project.presentation.document);
  const slideNames = await Promise.all(
    Array.from({ length: slideCount }, (_, i) => host.slideName(i)),
  );
  const docSizeTwips = await host.docSize();

  // Pre-render every slide on open. This is what makes playback switching an
  // image swap with no LOK call on the hot path (ADR-002 §9).
  for (let i = 0; i < slideCount; i++) {
    await host.render(i, SLIDE_W, SLIDE_H, join(CACHE_DIR, `slide-${i}.png`));
  }

  return { project, slideCount, slideNames, docSizeTwips, revision: Array(slideCount).fill(0) };
}

// ---- WebSocket: LOK events out --------------------------------------------

const wsClients = new Set<WebSocket>();

host.on("lokevent", (evt: HostEvent) => {
  const msg = JSON.stringify({ kind: "lokevent", ...evt });
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

// ---- HTTP ------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveFile(res: ServerResponse, path: string, cache: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": cache,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1_000_000) fail(new Error("body too large"));
    });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

type InputRequest =
  | { kind: "mouse"; type: "DOWN" | "UP" | "MOVE"; x: number; y: number; count: number; buttons: number; modifier: number }
  | { kind: "key"; type: "INPUT" | "UP"; charCode: number; keyCode: number };

// Symbolic names only — the browser never sends a `.uno:` string, matching
// the same boundary ADR-002 draws for this file relative to host.cpp.
const UNO_COMMANDS: Record<string, () => Promise<number>> = {
  bold: () => host.bold(),
  italic: () => host.italic(),
  underline: () => host.underline(),
  undo: () => host.undo(),
  redo: () => host.redo(),
  escape: () => host.escape(),
  selectAll: () => host.selectAll(),
  deleteSelection: () => host.deleteSelection(),
  startDrawRectangle: () => host.startDrawRectangle(),
  startInsertTextBox: () => host.startInsertTextBox(),
};

const EXPORT_MIME: Record<string, string> = {
  odp: "application/vnd.oasis.opendocument.presentation",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // The browser app (vite dev, a different port) and this server are
  // cross-origin. Local dev tool, nothing sensitive behind it — a permissive
  // origin is the right trade for zero configuration.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    // --- API ---------------------------------------------------------
    if (path === "/api/project") {
      if (!state) state = await openProject();
      return json(res, 200, {
        project: state.project,
        slideCount: state.slideCount,
        slideNames: state.slideNames,
        revision: state.revision,
        slideSize: { w: SLIDE_W, h: SLIDE_H },
        docSizeTwips: state.docSizeTwips,
      });
    }

    if (path === "/api/slide-time" && req.method === "POST") {
      if (!state) state = await openProject();
      const { slide, timeMs } = JSON.parse(await readBody(req)) as {
        slide: number;
        timeMs: number;
      };
      if (!Number.isInteger(slide) || slide < 0 || slide >= state.slideCount) {
        return json(res, 400, { error: "slide out of range" });
      }
      if (!Number.isFinite(timeMs) || timeMs < 0) {
        return json(res, 400, { error: "timeMs must be >= 0" });
      }

      const next = state.project.slideSync.filter((c) => c.slide !== slide);
      next.push({ slide, timeMs: Math.round(timeMs) });

      const problem = validateCues(next);
      if (problem) return json(res, 409, { error: problem });

      state.project.slideSync = next.sort((a, b) => a.timeMs - b.timeMs);
      await saveProject(PROJECT_DIR, state.project);
      return json(res, 200, { slideSync: state.project.slideSync });
    }

    /** Server-side resolution, exposed so the browser's local logic can be
     *  verified against the authority rather than trusted. */
    if (path === "/api/slide-at") {
      if (!state) state = await openProject();
      const t = Number(url.searchParams.get("t") ?? 0);
      return json(res, 200, { timeMs: t, slide: slideAt(state.project.slideSync, t) });
    }

    // Forwards MOUSE/KEY straight to the host (LokHost.mouse/.key) — see
    // host.cpp's protocol comment for coordinate units (twips, not pixels).
    // Stage 2's canvas is the real caller; this exists now so the protocol
    // addition from Stage 1 is actually reachable and testable end-to-end.
    if (path === "/api/input" && req.method === "POST") {
      if (!state) state = await openProject();
      const body = JSON.parse(await readBody(req)) as InputRequest;
      if (body.kind === "mouse") {
        await host.mouse(body.type, body.x, body.y, body.count, body.buttons, body.modifier);
      } else if (body.kind === "key") {
        await host.key(body.type, body.charCode, body.keyCode);
      } else {
        return json(res, 400, { error: "unknown input kind" });
      }
      return json(res, 200, { ok: true });
    }

    // Re-renders one slide on demand — the other half of /api/input: after
    // sending edits, the caller asks for a fresh tile and gets a bumped
    // revision so the browser's <img> cache-buster changes.
    const renderReq = /^\/api\/render\/(\d+)$/.exec(path);
    if (renderReq && req.method === "POST") {
      if (!state) state = await openProject();
      const index = Number(renderReq[1]);
      if (index < 0 || index >= state.slideCount) {
        return json(res, 400, { error: "slide out of range" });
      }
      await host.render(index, SLIDE_W, SLIDE_H, join(CACHE_DIR, `slide-${index}.png`));
      state.revision[index] = (state.revision[index] ?? 0) + 1;
      return json(res, 200, { revision: state.revision[index] });
    }

    // Symbolic toolbar commands — {command: "bold"} etc. See UNO_COMMANDS
    // above; unknown names are rejected rather than passed through, so this
    // can never become a free-text `.uno:` executor.
    if (path === "/api/uno" && req.method === "POST") {
      if (!state) state = await openProject();
      const { command } = JSON.parse(await readBody(req)) as { command: string };
      const fn = UNO_COMMANDS[command];
      if (!fn) return json(res, 400, { error: `unknown command: ${command}` });
      const parts = await fn();
      return json(res, 200, { parts });
    }

    // Duplicate/delete act on a specific slide index (unlike the commands
    // above, which act on whatever is currently selected/focused), so they
    // get their own route rather than folding into UNO_COMMANDS.
    const dup = /^\/api\/slide\/(\d+)\/duplicate$/.exec(path);
    if (dup && req.method === "POST") {
      if (!state) state = await openProject();
      const index = Number(dup[1]);
      state.slideCount = await host.duplicateSlide(index);
      state.slideNames = await Promise.all(
        Array.from({ length: state.slideCount }, (_, i) => host.slideName(i)),
      );
      state.revision = Array(state.slideCount).fill(0);
      for (let i = 0; i < state.slideCount; i++) {
        await host.render(i, SLIDE_W, SLIDE_H, join(CACHE_DIR, `slide-${i}.png`));
      }
      return json(res, 200, { slideCount: state.slideCount, slideNames: state.slideNames });
    }

    const del = /^\/api\/slide\/(\d+)\/delete$/.exec(path);
    if (del && req.method === "POST") {
      if (!state) state = await openProject();
      const index = Number(del[1]);
      if (state.slideCount <= 1) return json(res, 409, { error: "cannot delete the only slide" });
      state.slideCount = await host.deleteSlide(index);
      state.slideNames = await Promise.all(
        Array.from({ length: state.slideCount }, (_, i) => host.slideName(i)),
      );
      state.revision = Array(state.slideCount).fill(0);
      for (let i = 0; i < state.slideCount; i++) {
        await host.render(i, SLIDE_W, SLIDE_H, join(CACHE_DIR, `slide-${i}.png`));
      }
      return json(res, 200, { slideCount: state.slideCount, slideNames: state.slideNames });
    }

    // Round-trips through the real LibreOffice exporter proven in Stage 0
    // (saveAs → odp/pptx/pdf) and streams the file straight back rather than
    // a two-step "export then fetch" — there's nothing else to do with it.
    if (path === "/api/export" && req.method === "POST") {
      if (!state) state = await openProject();
      const { format } = JSON.parse(await readBody(req)) as { format: "odp" | "pptx" | "pdf" };
      if (!EXPORT_MIME[format]) return json(res, 400, { error: "unknown format" });
      const out = join(CACHE_DIR, `export.${format}`);
      await host.saveAs(format, out);
      const body = await readFile(out);
      res.writeHead(200, {
        "Content-Type": EXPORT_MIME[format],
        "Content-Length": body.length,
        "Content-Disposition": `attachment; filename="presentation.${format}"`,
      });
      return res.end(body);
    }

    // Attaches a song — the other half of GET /audio below. Streamed straight
    // to disk (temp file + rename, same atomic-write discipline project.ts's
    // save() uses) rather than buffered in memory: readBody() caps at 1MB,
    // which a multi-minute MP3 blows through immediately.
    if (path === "/api/audio" && req.method === "POST") {
      if (!state) state = await openProject();
      const ext = (url.searchParams.get("ext") || "mp3").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp3";
      const filename = `audio.${ext}`;
      const target = join(PROJECT_DIR, filename);
      const tmp = `${target}.tmp`;
      await pipeline(req, createWriteStream(tmp));
      await rename(tmp, target);

      state.project.audio = { source: filename, durationMs: 0 };
      await saveProject(PROJECT_DIR, state.project);
      return json(res, 200, { source: filename });
    }

    if (path === "/api/health") {
      return json(res, 200, { ok: true, hostRunning: host.running, wsClients: wsClients.size });
    }

    // --- media -------------------------------------------------------
    const slide = /^\/slides\/(\d+)\.png$/.exec(path);
    if (slide) {
      if (!state) state = await openProject();
      const file = join(CACHE_DIR, `slide-${slide[1]}.png`);
      // Revision-busted by the caller appending ?v=N, so this can be cached
      // hard without ever serving a stale tile after an edit.
      if (await serveFile(res, file, "public, max-age=31536000, immutable")) return;
      return json(res, 404, { error: "slide not rendered" });
    }

    if (path === "/audio") {
      if (!state) state = await openProject();
      const src = state.project.audio?.source;
      if (!src) return json(res, 404, { error: "no audio" });
      if (await serveFile(res, join(PROJECT_DIR, src), "public, max-age=3600")) return;
      return json(res, 404, { error: "audio file missing" });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[server]", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const wss = new WebSocketServer({ server, path: "/events" });
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`lok server  http://localhost:${PORT}`);
  console.log(`  events    ws://localhost:${PORT}/events`);
  console.log(`  projects  ${PROJECT_DIR}`);
  console.log(`  cache     ${CACHE_DIR}`);
  console.log(`  host      ${HOST_CMD} ${HOST_ARGS.join(" ")}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    host.stop();
    server.close(() => process.exit(0));
  });
}
