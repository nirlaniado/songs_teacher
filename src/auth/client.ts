import { z } from "zod";

// The accounts API over HTTP. Hard rule 10: nothing here imports from server/; the shapes are restated.
const UserReply = z.object({ user: z.object({ id: z.number(), username: z.string() }) });
export type User = z.infer<typeof UserReply>["user"];

export type Mode = "login" | "signup";
export type Session = { kind: "signedIn"; user: User } | { kind: "signedOut" } | { kind: "unreachable" };
export type Outcome = { ok: true; user: User } | { ok: false; error: string };

export const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...init?.headers } });
  } catch {
    return null;
  }
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function userOf(res: Response) {
  const parsed = UserReply.safeParse(await json(res));
  return parsed.success ? parsed.data.user : null;
}

export async function currentSession(): Promise<Session> {
  const res = await call("/api/auth/me");
  if (res?.status === 401) return { kind: "signedOut" };
  const user = res?.ok ? await userOf(res) : null;
  return user ? { kind: "signedIn", user } : { kind: "unreachable" };
}

export async function submit(mode: Mode, username: string, password: string): Promise<Outcome> {
  const res = await call(`/api/auth/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res || res.status >= 500) return { ok: false, error: UNREACHABLE };
  if (res.ok) {
    const user = await userOf(res);
    return user ? { ok: true, user } : { ok: false, error: "The server sent an answer this app doesn't understand." };
  }
  if (res.status === 429) return { ok: false, error: `Too many attempts. Try again ${waitFor(res.headers.get("retry-after"))}.` };
  const body = await json(res);
  const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
  return { ok: false, error: error ?? `The server refused that (${res.status}).` };
}

/** Whether the server ended the session. A failure leaves the cookie, so the person is still signed in. */
export async function signOut(): Promise<boolean> {
  const res = await call("/api/auth/logout", { method: "POST" });
  return !!res?.ok;
}

/** Retry-After is either seconds or an HTTP date. */
export function waitFor(retryAfter: string | null, now = Date.now()): string {
  if (!retryAfter) return "later";
  const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - now) / 1000;
  if (!Number.isFinite(seconds)) return "later";
  if (seconds <= 1) return "now";
  if (seconds < 60) return `in ${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
}
