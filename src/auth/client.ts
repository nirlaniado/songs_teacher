import { z } from "zod";

// The accounts API over HTTP. Hard rule 10: nothing here imports from server/; the shapes are restated.
const UserReply = z.object({
  user: z.object({ id: z.number(), username: z.string(), admin: z.boolean().optional(), mustChangePassword: z.boolean().optional() }),
});
export type User = z.infer<typeof UserReply>["user"];

export type Mode = "login" | "signup";
export type Session = { kind: "signedIn"; user: User } | { kind: "signedOut" } | { kind: "unreachable" };
export type Outcome = { ok: true; user: User } | { ok: false; error: string };
/**
 * Why a request was refused, beyond its message. `signedOut`: the server no longer knows this session, e.g. it was
 * ended from another device. `mustChange`: an admin reset the password, and nothing but changing it is allowed.
 * `forbidden`: any other 403.
 */
export interface Refusal { error: string; signedOut: boolean; mustChange: boolean; forbidden: boolean }
export type Done = { ok: true } | ({ ok: false } & Refusal);
export type Answer<T> = { ok: true; data: T } | ({ ok: false } & Refusal);

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
  if (res?.ok) {
    const user = await userOf(res);
    return user ? { ok: true, user } : { ok: false, error: "The server sent an answer this app doesn't understand." };
  }
  return { ok: false, error: await failure(res) };
}

async function failure(res: Response | null): Promise<string> {
  return (await refusal(res)).error;
}

const ErrorReply = z.object({ error: z.string(), code: z.string().optional() });

async function refusal(res: Response | null): Promise<Refusal> {
  const plain = { signedOut: false, mustChange: false, forbidden: false };
  if (!res || res.status >= 500) return { error: UNREACHABLE, ...plain };
  if (res.status === 429) return { error: `Too many attempts. Try again ${waitFor(res.headers.get("retry-after"))}.`, ...plain };
  const body = ErrorReply.safeParse(await json(res));
  const mustChange = res.status === 403 && body.success && body.data.code === "must_change_password";
  return {
    error: body.success ? body.data.error : `The server refused that (${res.status}).`,
    signedOut: res.status === 401,
    mustChange,
    forbidden: res.status === 403 && !mustChange,
  };
}

/** One call to the API whose answer, on success, must match `shape`. */
export async function request<T>(method: "GET" | "POST" | "DELETE", path: string, shape: z.ZodType<T>, body?: object): Promise<Answer<T>> {
  const res = await call(path, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });
  if (!res?.ok) return { ok: false, ...(await refusal(res)) };
  const data = shape.safeParse(await json(res));
  return data.success
    ? { ok: true, data: data.data }
    : { ok: false, error: "The server sent an answer this app doesn't understand.", signedOut: false, mustChange: false, forbidden: false };
}

async function act(method: "POST" | "DELETE", path: string, body?: object): Promise<Done> {
  const answer = await request(method, path, z.unknown(), body);
  return answer.ok ? { ok: true } : answer;
}

export const changePassword = (currentPassword: string, newPassword: string) =>
  act("POST", "/api/auth/password", { currentPassword, newPassword });
export const signOutEverywhere = () => act("POST", "/api/auth/logout-all");
export const deleteAccount = (password: string) => act("DELETE", "/api/auth/account", { password });

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
