import { describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app";
import type { Hasher } from "./auth";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };
const creds = { username: "alice", password: "password123" };
const NEW = "a new password";

async function setup(options: Partial<AppOptions> = {}) {
  const store = new MemoryStore();
  const app = await buildApp({ store, hasher: plain, ...options });
  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object, cookie?: string, ip = "127.0.0.1") =>
    app.inject({ method, url, payload, remoteAddress: ip, headers: cookie ? { cookie } : {} });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  const login = async (body = creds) => {
    const res = await call("POST", "/api/auth/login", body);
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
  };
  const signup = async (body = creds) => {
    const res = await call("POST", "/api/auth/signup", body);
    expect(res.statusCode).toBe(201);
    return cookieOf(res);
  };
  const me = async (cookie: string) => (await call("GET", "/api/auth/me", undefined, cookie)).statusCode;
  const password = (cookie: string | undefined, body: object, ip?: string) => call("POST", "/api/auth/password", body, cookie, ip);
  const remove = (cookie: string | undefined, body: object, ip?: string) => call("DELETE", "/api/auth/account", body, cookie, ip);
  const logoutAll = (cookie?: string) => call("POST", "/api/auth/logout-all", undefined, cookie);
  return { app, store, call, signup, login, me, password, remove, logoutAll };
}
const cleared = (res: { cookies: { name: string; value: string; expires?: Date }[] }) => {
  const c = res.cookies.find((x) => x.name === "session");
  return !!c && c.value === "" && c.expires!.getTime() <= Date.now();
};

describe("POST /api/auth/password", () => {
  it("changes the password, keeps this session and ends every other one", async () => {
    const { signup, login, me, password, call, store } = await setup();
    const here = await signup();
    const phone = await login();
    const laptop = await login();
    const res = await password(here, { currentPassword: creds.password, newPassword: NEW });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(await me(here)).toBe(200);
    expect(await me(phone)).toBe(401);
    expect(await me(laptop)).toBe(401);
    expect(store.sessionCount()).toBe(1);
    expect((await call("POST", "/api/auth/login", creds)).statusCode).toBe(401);
    expect(await me(await login({ ...creds, password: NEW }))).toBe(200);
  });

  it("refuses a wrong current password and changes nothing", async () => {
    const { signup, login, me, password } = await setup();
    const here = await signup();
    const other = await login();
    const res = await password(here, { currentPassword: "not my password", newPassword: NEW });
    expect([res.statusCode, res.json()]).toEqual([403, { error: "Wrong password." }]);
    expect(await me(other)).toBe(200);
    expect(await me(await login())).toBe(200);
  });

  it("holds the new password to the sign-up rule", async () => {
    const { signup, password } = await setup();
    const here = await signup();
    const res = await password(here, { currentPassword: creds.password, newPassword: "short" });
    expect([res.statusCode, res.json()]).toEqual([400, { error: "Password must be at least 10 characters." }]);
    expect((await password(here, { currentPassword: creds.password })).statusCode).toBe(400);
    expect((await password(here, { currentPassword: creds.password, newPassword: NEW, username: "bob" })).statusCode).toBe(400);
  });

  it("needs a live session", async () => {
    const { signup, password, call } = await setup();
    const here = await signup();
    expect((await password(undefined, { currentPassword: creds.password, newPassword: NEW })).statusCode).toBe(401);
    expect((await password("session=forged", { currentPassword: creds.password, newPassword: NEW })).statusCode).toBe(401);
    await call("POST", "/api/auth/logout", undefined, here);
    expect((await password(here, { currentPassword: creds.password, newPassword: NEW })).statusCode).toBe(401);
  });

  it("shares the account's lockout with login, so a stolen session can't guess the password", async () => {
    const { signup, password, call } = await setup({ lockout: { max: 3, windowMs: 60_000 } });
    const here = await signup();
    for (let i = 0; i < 3; i++) expect((await password(here, { currentPassword: `guess number ${i}`, newPassword: NEW })).statusCode).toBe(403);
    const locked = await password(here, { currentPassword: creds.password, newPassword: NEW });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await call("POST", "/api/auth/login", creds)).statusCode).toBe(429);
  });

  it("is rate-limited per IP", async () => {
    const { signup, password } = await setup({ rateLimit: { max: 2, timeWindow: 60_000 } });
    const here = await signup();
    const body = { currentPassword: "not my password", newPassword: NEW };
    expect((await password(here, body, "203.0.113.9")).statusCode).toBe(403);
    expect((await password(here, body, "203.0.113.9")).statusCode).toBe(403);
    expect((await password(here, body, "203.0.113.9")).statusCode).toBe(429);
  });
});

describe("POST /api/auth/logout-all", () => {
  it("ends every session of the user, this one included, and clears the cookie", async () => {
    const { signup, login, me, logoutAll, store } = await setup();
    const here = await signup();
    const other = await login();
    const res = await logoutAll(here);
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(cleared(res)).toBe(true);
    expect(await me(here)).toBe(401);
    expect(await me(other)).toBe(401);
    expect(store.sessionCount()).toBe(0);
  });

  it("leaves other users signed in", async () => {
    const { signup, me, logoutAll } = await setup();
    const alice = await signup();
    const bob = await signup({ username: "bob", password: "password456" });
    await logoutAll(alice);
    expect(await me(bob)).toBe(200);
  });

  it("needs a live session", async () => {
    const { logoutAll } = await setup();
    expect((await logoutAll()).statusCode).toBe(401);
    expect((await logoutAll("session=forged")).statusCode).toBe(401);
  });
});

describe("DELETE /api/auth/account", () => {
  it("deletes the user and every session of theirs, and clears the cookie", async () => {
    const { signup, login, me, remove, call, store } = await setup();
    const here = await signup();
    const other = await login();
    const bob = await signup({ username: "bob", password: "password456" });
    const res = await remove(here, { password: creds.password });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(cleared(res)).toBe(true);
    expect(await me(here)).toBe(401);
    expect(await me(other)).toBe(401);
    expect(await me(bob)).toBe(200);
    expect(store.sessionCount()).toBe(1);
    expect(await store.findUser("alice")).toBeNull();
    const after = await call("POST", "/api/auth/login", creds);
    expect([after.statusCode, after.json()]).toEqual([401, { error: "Wrong username or password." }]);
  });

  it("frees the username, and a new account under it gets a new id", async () => {
    const { signup, remove, call } = await setup();
    const here = await signup();
    await signup({ username: "bob", password: "password456" });
    await remove(here, { password: creds.password });
    const again = await call("POST", "/api/auth/signup", creds);
    expect(again.statusCode).toBe(201);
    expect(again.json().user.id).toBe(3);
  });

  it("refuses a wrong password and keeps the account", async () => {
    const { signup, me, remove } = await setup();
    const here = await signup();
    const res = await remove(here, { password: "not my password" });
    expect([res.statusCode, res.json()]).toEqual([403, { error: "Wrong password." }]);
    expect(await me(here)).toBe(200);
  });

  it("refuses the admin account, whatever the case of its name, even with the right password", async () => {
    const { signup, me, remove, call } = await setup({ adminUsername: "Owner" });
    const owner = await signup({ username: "owner", password: "password789" });
    const res = await remove(owner, { password: "password789" });
    expect([res.statusCode, res.json()]).toEqual([403, { error: "The admin account can't be deleted." }]);
    expect(await me(owner)).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "owner", password: "password789" })).statusCode).toBe(200);
  });

  it("tells the page which account is the admin, and nobody else", async () => {
    const { signup, call } = await setup({ adminUsername: "owner" });
    const owner = await signup({ username: "Owner", password: "password789" });
    const alice = await signup();
    expect((await call("GET", "/api/auth/me", undefined, owner)).json()).toEqual({ user: { id: 1, username: "Owner", admin: true } });
    expect((await call("GET", "/api/auth/me", undefined, alice)).json()).toEqual({ user: { id: 2, username: "alice" } });
    expect((await call("POST", "/api/auth/login", { username: "owner", password: "password789" })).json().user.admin).toBe(true);
  });

  it("needs a live session and a well-formed body", async () => {
    const { signup, remove } = await setup();
    const here = await signup();
    expect((await remove(undefined, { password: creds.password })).statusCode).toBe(401);
    expect((await remove(here, {})).statusCode).toBe(400);
    expect((await remove(here, { password: creds.password, username: "bob" })).statusCode).toBe(400);
  });

  it("shares the account's lockout and is rate-limited per IP", async () => {
    const locking = await setup({ lockout: { max: 2, windowMs: 60_000 } });
    const here = await locking.signup();
    for (let i = 0; i < 2; i++) await locking.remove(here, { password: `guess number ${i}` });
    expect((await locking.remove(here, { password: creds.password })).statusCode).toBe(429);
    expect(await locking.me(here)).toBe(200);

    const limited = await setup({ rateLimit: { max: 1, timeWindow: 60_000 } });
    const there = await limited.signup();
    expect((await limited.remove(there, { password: "not my password" }, "203.0.113.9")).statusCode).toBe(403);
    expect((await limited.remove(there, { password: creds.password }, "203.0.113.9")).statusCode).toBe(429);
    expect(await limited.me(there)).toBe(200);
  });
});
