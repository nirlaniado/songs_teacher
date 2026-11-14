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

  it("sets an httpOnly, SameSite=Lax, 30-day cookie", async () => {
    const { post } = await setup();
    const res = await post("/api/auth/signup", creds);
    const header = String(res.headers["set-cookie"]);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    const expires = Date.parse(res.cookies[0]!.expires!.toString());
    expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(30);
  });

  it("marks the cookie Secure from the original protocol, not the Host header", async () => {
    const signup = (app: Awaited<ReturnType<typeof setup>>["app"], username: string, headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/auth/signup", payload: { ...creds, username }, headers }).then((r) => String(r.headers["set-cookie"]));
    const { app: trusting } = await setup({ trustProxy: "loopback" });
    expect(await signup(trusting, "user1", { "x-forwarded-proto": "https", host: "127.0.0.1:4319" })).toMatch(/Secure/);
    expect(await signup(trusting, "user2", { "x-forwarded-proto": "http", host: "teacher.example.com" })).not.toMatch(/Secure/);
    expect(await signup(trusting, "user3", { host: "teacher.example.com" })).not.toMatch(/Secure/);
    const { app: untrusting } = await setup();
    expect(await signup(untrusting, "user4", { "x-forwarded-proto": "https" })).not.toMatch(/Secure/);
    const { app: wrongProxy } = await setup({ trustProxy: "10.0.0.1" });
    expect(await signup(wrongProxy, "user5", { "x-forwarded-proto": "https" })).not.toMatch(/Secure/);
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

  it("gives two clients separate limits, directly and behind a trusted proxy", async () => {
    const limit = { rateLimit: { max: 2, timeWindow: 60_000 } };
    const login = (app: Awaited<ReturnType<typeof setup>>["app"], extra: object) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { ...creds, username: `u${Math.random()}`.slice(0, 10).replace(".", "") }, ...extra }).then((r) => r.statusCode);

    const { app: direct } = await setup(limit);
    const a = { remoteAddress: "198.51.100.1" }, b = { remoteAddress: "198.51.100.2" };
    expect([await login(direct, a), await login(direct, a), await login(direct, a)]).toEqual([401, 401, 429]);
    expect(await login(direct, b)).toBe(401);

    const { app: proxied } = await setup({ ...limit, trustProxy: "loopback" });
    const viaProxy = (ip: string) => ({ remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": ip } });
    expect([await login(proxied, viaProxy("203.0.113.1")), await login(proxied, viaProxy("203.0.113.1")), await login(proxied, viaProxy("203.0.113.1"))]).toEqual([401, 401, 429]);
    expect(await login(proxied, viaProxy("203.0.113.2"))).toBe(401);
  });

  it("ignores X-Forwarded-For from an untrusted peer, so spoofing it can't dodge the limit", async () => {
    const { app } = await setup({ rateLimit: { max: 2, timeWindow: 60_000 } });
    const statuses = [];
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"])
      statuses.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: creds, remoteAddress: "198.51.100.9", headers: { "x-forwarded-for": ip } })).statusCode);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("locks one username after repeated failures, from any IP, without touching others", async () => {
    let now = Date.UTC(2026, 0, 1);
    const { app, post } = await setup({ now: () => now, lockout: { max: 3, windowMs: 60_000 } });
    await post("/api/auth/signup", creds);
    await post("/api/auth/signup", { ...creds, username: "bob" });
    const login = (body: object, ip: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: body, remoteAddress: ip });

    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"])
      expect((await login({ ...creds, password: "wrongpassword" }, ip)).statusCode).toBe(401);
    const locked = await login({ ...creds, username: "ALICE" }, "198.51.100.4");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBe(60);
    expect((await login({ ...creds, username: "bob" }, "198.51.100.1")).statusCode).toBe(200);

    now += 60_000;
    expect((await login(creds, "198.51.100.4")).statusCode).toBe(200);
  });

  it("clears an account's failure count on a successful login", async () => {
    const { post } = await setup({ lockout: { max: 2, windowMs: 60_000 } });
    await post("/api/auth/signup", creds);
    await post("/api/auth/login", { ...creds, password: "wrongpassword" });
    expect((await post("/api/auth/login", creds)).statusCode).toBe(200);
    await post("/api/auth/login", { ...creds, password: "wrongpassword" });
    expect((await post("/api/auth/login", creds)).statusCode).toBe(200);
  });

  it("locks unknown usernames the same way, so lockout doesn't reveal which exist", async () => {
    const { post } = await setup({ lockout: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 2; i++) await post("/api/auth/login", { ...creds, username: "nobody" });
    expect((await post("/api/auth/login", { ...creds, username: "nobody" })).statusCode).toBe(429);
  });

  it("computes the dummy hash before serving, not on the first unknown-username login", async () => {
    let hashes = 0;
    const counting: Hasher = { hash: async (p) => { hashes++; return plain.hash(p); }, verify: plain.verify };
    const { post } = await setup({ hasher: counting });
    expect(hashes).toBe(1);
    expect((await post("/api/auth/login", { ...creds, username: "nobody" })).statusCode).toBe(401);
    expect(hashes).toBe(1);
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
