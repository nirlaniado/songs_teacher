import { describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app";
import type { Hasher } from "./auth";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };
const creds = { username: "alice", password: "password123" };

async function setup(options: Partial<AppOptions> = {}) {
  const store = new MemoryStore();
  const app = await buildApp({ store, hasher: plain, ...options });
  const post = (url: string, payload?: object, cookie?: string) =>
    app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
  const me = (cookie?: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: cookie ? { cookie } : {} });
  return { app, store, post, me };
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `session=${res.cookies.find((c) => c.name === "session")!.value}`;

describe("auth API", () => {
  it("runs signup → me → logout → me 401 → login → me", async () => {
    const { post, me } = await setup();
    const signup = await post("/api/auth/signup", creds);
    expect(signup.statusCode).toBe(201);
    expect(signup.json()).toEqual({ user: { id: 1, username: "alice" } });
    const first = cookieOf(signup);
    expect((await me(first)).json()).toEqual({ user: { id: 1, username: "alice" } });

    expect((await post("/api/auth/logout", undefined, first)).statusCode).toBe(200);
    expect((await me(first)).statusCode).toBe(401);

    const login = await post("/api/auth/login", creds);
    expect(login.statusCode).toBe(200);
    expect((await me(cookieOf(login))).statusCode).toBe(200);
  });

  it("never returns the password hash", async () => {
    const { post, me } = await setup();
    const responses = [await post("/api/auth/signup", creds), await post("/api/auth/login", creds)];
    responses.push(await me(cookieOf(responses[1]!)));
    for (const r of responses) expect(r.body).not.toMatch(/h:|hash/i);
  });

  it("sets an httpOnly, SameSite=Lax, 30-day cookie, Secure only off localhost", async () => {
    const { app } = await setup();
    const local = await app.inject({ method: "POST", url: "/api/auth/signup", payload: creds, headers: { host: "localhost:5173" } });
    const header = String(local.headers["set-cookie"]);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).not.toMatch(/Secure/);
    const expires = Date.parse(local.cookies[0]!.expires!.toString());
    expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(30);

    const remote = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { ...creds, username: "bob" }, headers: { host: "teacher.example.com" } });
    expect(String(remote.headers["set-cookie"])).toMatch(/Secure/);
  });

  it("treats usernames as unique ignoring case", async () => {
    const { post } = await setup();
    await post("/api/auth/signup", creds);
    const dup = await post("/api/auth/signup", { ...creds, username: "ALICE" });
    expect(dup.statusCode).toBe(409);
    expect((await post("/api/auth/login", { ...creds, username: "Alice" })).statusCode).toBe(200);
  });

  it("rejects invalid signups with 400", async () => {
    const { post } = await setup();
    expect((await post("/api/auth/signup", { username: "a b", password: "password123" })).statusCode).toBe(400);
    expect((await post("/api/auth/signup", { username: "alice", password: "short" })).statusCode).toBe(400);
    expect((await post("/api/auth/signup", {})).statusCode).toBe(400);
  });

  it("answers a wrong password, unknown user and malformed body identically", async () => {
    const { post } = await setup();
    await post("/api/auth/signup", creds);
    const bodies = await Promise.all([
      post("/api/auth/login", { ...creds, password: "wrongpassword" }),
      post("/api/auth/login", { ...creds, username: "nobody" }),
      post("/api/auth/login", { username: "x" }),
    ]);
    for (const r of bodies) expect([r.statusCode, r.json()]).toEqual([401, { error: "Wrong username or password." }]);
  });

  it("rejects a forged cookie", async () => {
    const { me } = await setup();
    expect((await me("session=not-a-real-token")).statusCode).toBe(401);
  });

  it("rate-limits signup and login per IP", async () => {
    const { post } = await setup({ rateLimit: { max: 2, timeWindow: 60_000 } });
    await post("/api/auth/login", creds);
    await post("/api/auth/login", creds);
    expect((await post("/api/auth/login", creds)).statusCode).toBe(429);
    await post("/api/auth/signup", creds);
    await post("/api/auth/signup", { ...creds, username: "bob" });
    expect((await post("/api/auth/signup", { ...creds, username: "carol" })).statusCode).toBe(429);
  });

  it("reports database reachability on /api/health", async () => {
    const { app, store } = await setup();
    const up = await app.inject({ method: "GET", url: "/api/health" });
    expect([up.statusCode, up.json()]).toEqual([200, { ok: true, database: "reachable" }]);
    store.down = true;
    const down = await app.inject({ method: "GET", url: "/api/health" });
    expect([down.statusCode, down.json()]).toEqual([503, { ok: false, database: "unreachable" }]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: creds });
    expect(login.statusCode).toBe(500);
    expect(login.body).not.toMatch(/unreachable|stack/);
  });

  it("answers 503 everywhere when no database is configured", async () => {
    const app = await buildApp({ store: null });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: false, database: "not configured" });
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(503);
  });
});
