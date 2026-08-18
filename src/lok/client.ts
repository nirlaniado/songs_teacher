/**
 * Thin client for the LOK server (`lok/server/index.ts`) — the browser side
 * of the boundary ADR-002 draws. Every function here is a dumb pass-through
 * to an HTTP or WebSocket call; nothing here knows what a `.uno:` command is
 * (`unoCommand()` takes the same symbolic names the server's `UNO_COMMANDS`
 * map accepts), and nothing here owns state — `LokDeckScreen` does.
 *
 * Hardcoded to localhost:8091 rather than reading a configured endpoint: this
 * is an experimental, manually-started local dev server (`npm run lok:server`
 * in a second terminal), not a deployed service — same spirit as the LOK
 * server itself defaulting to native paths instead of Docker. Revisit once
 * Stage 4+ makes this a real, always-on part of the app.
 */

export const LOK_SERVER = "http://localhost:8091";

export interface SlideCue {
  slide: number;
  timeMs: number;
}

export interface LokProject {
  project: {
    schemaVersion: number;
    presentation: { document: string };
    audio: { source: string; durationMs: number } | null;
    slideSync: SlideCue[];
  };
  slideCount: number;
  slideNames: string[];
  revision: number[];
  /** PNG render size in pixels — NOT the coordinate space for input. */
  slideSize: { w: number; h: number };
  /** Twips — what LokCanvas actually needs for pointer/selection math. */
  docSizeTwips: { w: number; h: number };
}

export class LokClientError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${LOK_SERVER}${path}`, init);
  } catch {
    throw new LokClientError(
      `can't reach the LOK server at ${LOK_SERVER} — is "npm run lok:server" running?`,
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new LokClientError(
      (body as { error?: string }).error ?? `${path} failed: ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getProject(): Promise<LokProject> {
  return req<LokProject>("/api/project");
}

export function slideUrl(index: number, revision: number): string {
  return `${LOK_SERVER}/slides/${index}.png?v=${revision}`;
}

// ---- music (Stage 4) --------------------------------------------------------

export function audioUrl(): string {
  return `${LOK_SERVER}/audio`;
}

/** Streams the file straight to the server (see index.ts's /api/audio —
 *  streamed to disk, not buffered, so this isn't capped the way postJson's
 *  bodies are). `file.type`/`file.name`'s extension picks the stored format. */
export async function attachAudio(file: File): Promise<{ source: string }> {
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
  const res = await fetch(`${LOK_SERVER}/api/audio?ext=${encodeURIComponent(ext)}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new LokClientError((body as { error?: string }).error ?? `attach audio failed: ${res.status}`);
  }
  return res.json() as Promise<{ source: string }>;
}

export function setSlideTime(
  slide: number,
  timeMs: number,
): Promise<{ slideSync: SlideCue[] }> {
  return postJson("/api/slide-time", { slide, timeMs });
}

// ---- input (Stage 2 canvas) -----------------------------------------------

export type MouseInput = {
  kind: "mouse";
  type: "DOWN" | "UP" | "MOVE";
  x: number;
  y: number;
  count: number;
  buttons: number;
  modifier: number;
};
export type KeyInput = { kind: "key"; type: "INPUT" | "UP"; charCode: number; keyCode: number };

export function postInput(body: MouseInput | KeyInput): Promise<{ ok: true }> {
  return postJson("/api/input", body);
}

export function postRender(index: number): Promise<{ revision: number }> {
  return postJson(`/api/render/${index}`, {});
}

// ---- toolbar commands (Stage 3) --------------------------------------------

/** Symbolic names only, matching lok/server/index.ts's UNO_COMMANDS map —
 *  see host.ts for why `.uno:` strings never cross this boundary. */
export type UnoCommand =
  | "bold" | "italic" | "underline"
  | "undo" | "redo"
  | "escape" | "selectAll" | "deleteSelection"
  | "startDrawRectangle" | "startInsertTextBox";

export function unoCommand(command: UnoCommand): Promise<{ parts: number }> {
  return postJson("/api/uno", { command });
}

export function duplicateSlide(
  index: number,
): Promise<{ slideCount: number; slideNames: string[] }> {
  return postJson(`/api/slide/${index}/duplicate`, {});
}

export function deleteSlide(
  index: number,
): Promise<{ slideCount: number; slideNames: string[] }> {
  return postJson(`/api/slide/${index}/delete`, {});
}

export async function exportAs(format: "odp" | "pptx" | "pdf"): Promise<Blob> {
  const res = await fetch(`${LOK_SERVER}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format }),
  });
  if (!res.ok) throw new LokClientError(`export failed: ${res.status}`);
  return res.blob();
}

// ---- events (Stage 2 selection overlay) ------------------------------------

export interface LokEvent {
  kind: "lokevent";
  type: string;
  payload: string;
}

/** Caller owns the returned socket's lifecycle (close it on unmount). */
export function connectEvents(onEvent: (evt: LokEvent) => void): WebSocket {
  const ws = new WebSocket(`${LOK_SERVER.replace(/^http/, "ws")}/events`);
  ws.addEventListener("message", (msg) => {
    try {
      const parsed = JSON.parse(String(msg.data)) as LokEvent;
      if (parsed.kind === "lokevent") onEvent(parsed);
    } catch {
      /* not a message we understand — ignore rather than crash the socket */
    }
  });
  return ws;
}
