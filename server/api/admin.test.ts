import { describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app";
import type { Hasher } from "./auth";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };
const OWNER = { username: "owner", password: "owner password" };
const ALICE = { username: "alice", password: "alice password" };
const T0 = Date.parse("2026-11-15T10:00:00Z");

type Method = "GET" | "POST" | "DELETE";
async function setup(options: Partial<AppOptions> = {}) {
  let now = T0;
  const store = new MemoryStore(() => new Date(now));
  const app = await buildApp({ store, hasher: plain, adminUsername: "Owner", now: () => now, ...options });
  const call = (method: Method, url: string, cookie?: string, payload?: object) =>
    app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  const login = async (body: object) => {
    const res = await call("POST", "/api/auth/login", undefined, body);
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
  };
  // The admin account is made by api:make-admin, never by sign-up, so tests make it in the store directly.
  await store.createUser(OWNER.username, await plain.hash(OWNER.password));
  const admin = await login(OWNER);
  const signup = async (body: object) => {
    const res = await call("POST", "/api/auth/signup", undefined, body);
    expect(res.statusCode).toBe(201);
    return { cookie: cookieOf(res), id: res.json().user.id as number };
  };
  const alice = await signup(ALICE);
  const status = async (cookie: string) => (await call("GET", "/api/auth/me", cookie)).statusCode;
  const audit = async () => (await call("GET", "/api/admin/audit", admin)).json().entries as Array<Record<string, unknown>>;
  const tick = (ms: number) => { now += ms; };
  return { app, store, call, login, signup, admin, alice, status, audit, tick, cookieOf };
}

const actions = (id: number): Array<[Method, string]> => [
  ["POST", `/api/admin/users/${id}/disable`],
  ["POST", `/api/admin/users/${id}/enable`],
  ["POST", `/api/admin/users/${id}/reset-password`],
  ["DELETE", `/api/admin/users/${id}`],
];
const routes = (id: number): Array<[Method, string]> => [["GET", "/api/admin/users"], ["GET", "/api/admin/audit"], ...actions(id)];

describe("only the admin reaches /api/admin", () => {
  it("answers 401 when signed out and 403 to any other user, changing nothing", async () => {
    const { call, alice, signup, status, audit } = await setup();
    const bob = await signup({ username: "bob", password: "bob password" });
    for (const [method, url] of routes(bob.id)) {
      expect([method, url, (await call(method, url)).statusCode]).toEqual([method, url, 401]);
      expect([method, url, (await call(method, url, "session=forged")).statusCode]).toEqual([method, url, 401]);
      const refused = await call(method, url, alice.cookie);
      expect([method, url, refused.statusCode, refused.json()]).toEqual([method, url, 403, { error: "Only the admin can do that." }]);
    }
    expect(await status(bob.cookie)).toBe(200);
    expect(await audit()).toEqual([]);
  });

  it("answers 503 when no database is configured", async () => {
    const app = await buildApp({ store: null, adminUsername: "owner" });
    expect((await app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(503);
  });
});

describe("GET /api/admin/users", () => {
  it("lists id, username, created at, disabled, must-change-password, last sign-in and which one is the admin", async () => {
    const { call, admin, signup, tick } = await setup();
    tick(60_000);
    await signup({ username: "bob", password: "bob password" });
    const res = await call("GET", "/api/admin/users", admin);
    expect(res.json()).toEqual({
      users: [
        { id: 1, username: "owner", createdAt: "2026-11-15T10:00:00.000Z", disabled: false, mustChangePassword: false, lastSignInAt: "2026-11-15T10:00:00.000Z", admin: true },
        { id: 2, username: "alice", createdAt: "2026-11-15T10:00:00.000Z", disabled: false, mustChangePassword: false, lastSignInAt: "2026-11-15T10:00:00.000Z", admin: false },
        { id: 3, username: "bob", createdAt: "2026-11-15T10:01:00.000Z", disabled: false, mustChangePassword: false, lastSignInAt: "2026-11-15T10:01:00.000Z", admin: false },
      ],
      total: 3, page: 1, perPage: 50,
    });
    expect(res.body).not.toMatch(/h:|hash/i);
  });

  it("updates last sign-in on each login", async () => {
    const { call, admin, login, tick } = await setup();
    tick(3_600_000);
    await login(ALICE);
    const alice = (await call("GET", "/api/admin/users?search=alice", admin)).json().users[0];
    expect(alice.lastSignInAt).toBe("2026-11-15T11:00:00.000Z");
  });

  it("pages and searches by username, ignoring case", async () => {
    const { call, admin, signup } = await setup();
    for (const name of ["bob", "Bobby", "carol", "rob_ert", "rob1ert"]) await signup({ username: name, password: "some password" });
    const page = async (query: string) => (await call("GET", `/api/admin/users?${query}`, admin)).json();
    expect(await page("perPage=2&page=2")).toMatchObject({ total: 7, page: 2, perPage: 2, users: [{ username: "bob" }, { username: "Bobby" }] });
    expect((await page("perPage=2&page=4")).users.map((u: { username: string }) => u.username)).toEqual(["rob1ert"]);
    expect((await page("perPage=2&page=5")).users).toEqual([]);
    expect((await page("search=BOB")).users.map((u: { username: string }) => u.username)).toEqual(["bob", "Bobby"]);
    expect((await page("search=ob")).total).toBe(4);
    expect((await page("search=b_e")).users.map((u: { username: string }) => u.username)).toEqual(["rob_ert"]);
    expect((await page("search=nobody")).users).toEqual([]);
  });

  it.each(["page=0", "perPage=0", "perPage=101", "page=x", `search=${"a".repeat(33)}`, "sort=name"])("refuses %s with 400", async (query) => {
    const { call, admin } = await setup();
    expect((await call("GET", `/api/admin/users?${query}`, admin)).statusCode).toBe(400);
  });
});

describe("disable and enable", () => {
  it("disabling ends the user's sessions and blocks sign-in with a distinct error once the password is right", async () => {
    const { call, admin, alice, login, status, store } = await setup();
    const other = await login(ALICE);
    const res = await call("POST", `/api/admin/users/${alice.id}/disable`, admin);
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(await status(alice.cookie)).toBe(401);
    expect(await status(other)).toBe(401);
    expect(store.sessionCount()).toBe(1);
    const right = await call("POST", "/api/auth/login", undefined, ALICE);
    expect([right.statusCode, right.json(), right.headers["set-cookie"]]).toEqual([403, { error: "This account is disabled.", code: "account_disabled" }, undefined]);
  });

  it("a wrong password on a disabled account gets the ordinary answer and counts toward lockout", async () => {
    const { call, admin, alice } = await setup({ lockout: { max: 2, windowMs: 60_000 } });
    await call("POST", `/api/admin/users/${alice.id}/disable`, admin);
    const wrong = { ...ALICE, password: "not her password" };
    const unknown = await call("POST", "/api/auth/login", undefined, { username: "nobody", password: "not her password" });
    for (let i = 0; i < 2; i++) {
      const res = await call("POST", "/api/auth/login", undefined, wrong);
      expect([res.statusCode, res.json()]).toEqual([unknown.statusCode, unknown.json()]);
    }
    expect((await call("POST", "/api/auth/login", undefined, ALICE)).statusCode).toBe(429);
  });

  it("a session that slips in for a disabled user counts for nothing", async () => {
    const { call, admin, alice, store, status } = await setup();
    await call("POST", `/api/admin/users/${alice.id}/disable`, admin);
    const { createHash } = await import("node:crypto");
    await store.createSession(createHash("sha256").update("late").digest("hex"), alice.id, new Date(T0 + 86_400_000));
    expect(await status("session=late")).toBe(401);
  });

  it("enabling lets the user sign in again", async () => {
    const { call, admin, alice, login } = await setup();
    await call("POST", `/api/admin/users/${alice.id}/disable`, admin);
    expect((await call("POST", `/api/admin/users/${alice.id}/enable`, admin)).json()).toEqual({ ok: true });
    await login(ALICE);
  });
});

describe("reset-password", () => {
  it("returns a strong temporary password once, ends the user's sessions and sets must-change-password", async () => {
    const { call, admin, alice, status, login } = await setup();
    const res = await call("POST", `/api/admin/users/${alice.id}/reset-password`, admin);
    expect(res.statusCode).toBe(200);
    const { temporaryPassword } = res.json();
    expect(Object.keys(res.json())).toEqual(["temporaryPassword"]);
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await status(alice.cookie)).toBe(401);
    expect((await call("POST", "/api/auth/login", undefined, ALICE)).statusCode).toBe(401);
    const temp = await login({ username: "alice", password: temporaryPassword });
    expect((await call("GET", "/api/auth/me", temp)).json()).toEqual({ user: { id: alice.id, username: "alice", mustChangePassword: true } });
    const listed = (await call("GET", "/api/admin/users?search=alice", admin)).json().users[0];
    expect(listed.mustChangePassword).toBe(true);
  });

  it("gives a different password each time, and none of them reaches the audit table", async () => {
    const { call, admin, alice, audit } = await setup();
    const passwords = new Set<string>();
    for (let i = 0; i < 5; i++) passwords.add((await call("POST", `/api/admin/users/${alice.id}/reset-password`, admin)).json().temporaryPassword);
    expect(passwords.size).toBe(5);
    const rows = JSON.stringify(await audit());
    for (const p of passwords) expect(rows).not.toContain(p);
  });
});

describe("a must-change-password account", () => {
  async function mustChange() {
    const s = await setup();
    const { temporaryPassword } = (await s.call("POST", `/api/admin/users/${s.alice.id}/reset-password`, s.admin)).json();
    const res = await s.call("POST", "/api/auth/login", undefined, { username: "alice", password: temporaryPassword });
    expect(res.json()).toEqual({ user: { id: s.alice.id, username: "alice", mustChangePassword: true } });
    return { ...s, temp: s.cookieOf(res), temporaryPassword };
  }
  const MUST = { error: "Change your password before doing anything else.", code: "must_change_password" };

  it("gets a distinct error from every route but me, change-password and the sign-outs", async () => {
    const { call, temp } = await mustChange();
    const blocked: Array<[Method, string, object?]> = [["DELETE", "/api/auth/account", { password: "x" }], ...routes(1)];
    for (const [method, url, body] of blocked) {
      const res = await call(method, url, temp, body);
      expect([method, url, res.statusCode, res.json()]).toEqual([method, url, 403, MUST]);
    }
    expect((await call("GET", "/api/auth/me", temp)).statusCode).toBe(200);
  });

  it("is free again once the password is changed, which clears the flag", async () => {
    const { call, temp, temporaryPassword, admin, cookieOf } = await mustChange();
    const changed = await call("POST", "/api/auth/password", temp, { currentPassword: temporaryPassword, newPassword: "alice new password" });
    expect(changed.statusCode).toBe(200);
    const fresh = cookieOf(changed);
    expect((await call("GET", "/api/auth/me", fresh)).json()).toEqual({ user: { id: 2, username: "alice" } });
    expect((await call("DELETE", "/api/auth/account", fresh, { password: "not it" })).json()).toEqual({ error: "Wrong password." });
    expect((await call("GET", "/api/admin/users?search=alice", admin)).json().users[0].mustChangePassword).toBe(false);
  });

  it.each([["logout"], ["logout-all"]])("can still %s", async (route) => {
    const { call, temp, status } = await mustChange();
    expect((await call("POST", `/api/auth/${route}`, temp)).statusCode).toBe(200);
    expect(await status(temp)).toBe(401);
  });

  it("does not stop anyone else signing in or up while its cookie is sent along", async () => {
    const { call, temp } = await mustChange();
    expect((await call("POST", "/api/auth/signup", temp, { username: "dave", password: "dave password" })).statusCode).toBe(201);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  it("deletes the user and their sessions for good, and frees the name", async () => {
    const { call, admin, alice, status, store } = await setup();
    expect((await call("DELETE", `/api/admin/users/${alice.id}`, admin)).json()).toEqual({ ok: true });
    expect(await status(alice.cookie)).toBe(401);
    expect(await store.findUser("alice")).toBeNull();
    expect((await call("POST", "/api/auth/login", undefined, ALICE)).statusCode).toBe(401);
    expect((await call("DELETE", `/api/admin/users/${alice.id}`, admin)).statusCode).toBe(404);
    expect((await call("POST", "/api/auth/signup", undefined, ALICE)).statusCode).toBe(201);
  });
});

describe("the admin account protects itself", () => {
  it("cannot be disabled, enabled, reset or deleted through the API, whatever the admin's own session", async () => {
    const { call, admin, status, audit, login } = await setup();
    for (const [method, url] of actions(1)) {
      const res = await call(method, url, admin);
      expect([url, res.statusCode, res.json()]).toEqual([url, 403, { error: "The admin account can't be changed here." }]);
    }
    expect(await status(admin)).toBe(200);
    await login(OWNER);
    expect(await audit()).toEqual([]);
  });
});

describe("targets", () => {
  it.each(["abc", "0", "-1", "1.5", "99999999999999999999"])("refuses id %s with 400", async (id) => {
    const { call, admin } = await setup();
    expect((await call("POST", `/api/admin/users/${id}/disable`, admin)).statusCode).toBe(400);
  });

  it("answers 404 for a user that doesn't exist, and writes no audit row", async () => {
    const { call, admin, audit } = await setup();
    for (const [method, url] of actions(42)) expect((await call(method, url, admin)).statusCode).toBe(404);
    expect(await audit()).toEqual([]);
  });
});

describe("GET /api/admin/audit", () => {
  it("records every action with its time and target, newest first, and keeps them after the user is deleted", async () => {
    const { call, admin, alice, audit, tick } = await setup();
    for (const action of ["disable", "enable", "reset-password"]) {
      tick(1000);
      await call("POST", `/api/admin/users/${alice.id}/${action}`, admin);
    }
    tick(1000);
    await call("DELETE", `/api/admin/users/${alice.id}`, admin);
    expect(await audit()).toEqual([
      { id: 4, at: "2026-11-15T10:00:04.000Z", action: "delete", targetUserId: alice.id, targetUsername: "alice" },
      { id: 3, at: "2026-11-15T10:00:03.000Z", action: "reset-password", targetUserId: alice.id, targetUsername: "alice" },
      { id: 2, at: "2026-11-15T10:00:02.000Z", action: "enable", targetUserId: alice.id, targetUsername: "alice" },
      { id: 1, at: "2026-11-15T10:00:01.000Z", action: "disable", targetUserId: alice.id, targetUsername: "alice" },
    ]);
    const page = (await call("GET", "/api/admin/audit?perPage=1&page=2", admin)).json();
    expect(page).toMatchObject({ total: 4, page: 2, perPage: 1, entries: [{ id: 3 }] });
  });

  it("writes nothing for a refused or failed action", async () => {
    const { call, admin, alice, audit, store } = await setup();
    store.down = true;
    expect((await call("POST", `/api/admin/users/${alice.id}/disable`, admin)).statusCode).toBe(500);
    store.down = false;
    expect(await audit()).toEqual([]);
  });
});
