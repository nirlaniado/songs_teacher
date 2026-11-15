import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { sessionId, type Hasher } from "./auth";
import { MemoryStore } from "./store";

// Work authorized before an admin action must not land after it. Each test drives one interleaving
// deterministically: the user's request passes its check, the admin action runs to completion, and only then does
// the request attempt its write. The hasher's verify is where the check happens, so the admin action is run there.
const ALICE = { username: "alice", password: "alice password" };
type Method = "GET" | "POST" | "DELETE";

async function setup() {
  let between: (() => Promise<void>) | null = null;
  const gated: Hasher = {
    hash: async (p) => `h:${p}`,
    verify: async (h, p) => {
      const ok = h === `h:${p}`;
      const run = between;
      between = null;
      await run?.();
      return ok;
    },
  };
  const store = new MemoryStore();
  const app = await buildApp({ store, hasher: gated, adminUsername: "owner" });
  const call = (method: Method, url: string, cookie?: string, payload?: object) =>
    app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === "session");
  await store.createUser("owner", "h:owner password");
  const admin = `session=${cookieOf(await call("POST", "/api/auth/login", undefined, { username: "owner", password: "owner password" }))!.value}`;
  const signup = await call("POST", "/api/auth/signup", undefined, ALICE);
  const alice = { id: signup.json().user.id as number, cookie: `session=${cookieOf(signup)!.value}` };
  const adminDoes = (action: "disable" | "enable" | "reset-password" | "delete") => async () => {
    const res = action === "delete"
      ? await call("DELETE", `/api/admin/users/${alice.id}`, admin)
      : await call("POST", `/api/admin/users/${alice.id}/${action}`, admin);
    expect(res.statusCode).toBe(200);
    if (action === "reset-password") temporary = res.json().temporaryPassword;
  };
  let temporary = "";
  const login = (password: string) => call("POST", "/api/auth/login", undefined, { username: "alice", password });
  return {
    store, call, admin, alice, adminDoes, login, cookieOf,
    temporary: () => temporary,
    duringVerify: (fn: () => Promise<void>) => { between = fn; },
    aliceSessions: async () => sessionsOf(store, alice.id),
  };
}
/** MemoryStore keeps its sessions private; the tests count them to prove a refused write left none behind. */
function sessionsOf(store: MemoryStore, userId: number) {
  const { sessions } = store as unknown as { sessions: Map<string, { userId: number }> };
  return [...sessions.values()].filter((s) => s.userId === userId).length;
}

describe("a login whose password was verified before an admin action", () => {
  it("vs disable: answers disabled, sets no cookie and starts no session", async () => {
    const t = await setup();
    t.duringVerify(t.adminDoes("disable"));
    const res = await t.login(ALICE.password);
    expect([res.statusCode, res.json()]).toEqual([403, { error: "This account is disabled.", code: "account_disabled" }]);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(await t.aliceSessions()).toBe(0);
  });

  it("vs reset: answers wrong password, starts no session, and the temporary password still works", async () => {
    const t = await setup();
    t.duringVerify(t.adminDoes("reset-password"));
    const res = await t.login(ALICE.password);
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Wrong username or password." }]);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(await t.aliceSessions()).toBe(0);
    const temp = await t.login(t.temporary());
    expect(temp.json()).toEqual({ user: { id: t.alice.id, username: "alice", mustChangePassword: true } });
  });

  it("vs delete: answers wrong password and starts no session", async () => {
    const t = await setup();
    t.duringVerify(t.adminDoes("delete"));
    const res = await t.login(ALICE.password);
    expect(res.statusCode).toBe(401);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(await t.aliceSessions()).toBe(0);
  });
});

describe("a password change whose current password was verified before an admin action", () => {
  const change = (t: Awaited<ReturnType<typeof setup>>) =>
    t.call("POST", "/api/auth/password", t.alice.cookie, { currentPassword: ALICE.password, newPassword: "alice chosen password" });

  it("vs reset: 401, nothing written, and the reset stands", async () => {
    const t = await setup();
    t.duringVerify(t.adminDoes("reset-password"));
    const res = await change(t);
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not signed in." }]);
    expect(t.cookieOf(res)).toBeUndefined();
    expect(await t.aliceSessions()).toBe(0);
    expect((await t.login("alice chosen password")).statusCode).toBe(401);
    expect((await t.login(ALICE.password)).statusCode).toBe(401);
    expect((await t.login(t.temporary())).json().user.mustChangePassword).toBe(true);
  });

  it("vs disable: 401, nothing written, and the account stays disabled with its old password", async () => {
    const t = await setup();
    t.duringVerify(t.adminDoes("disable"));
    const res = await change(t);
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not signed in." }]);
    expect(await t.aliceSessions()).toBe(0);
    expect((await t.login(ALICE.password)).json()).toEqual({ error: "This account is disabled.", code: "account_disabled" });
    await t.adminDoes("enable")();
    expect((await t.login("alice chosen password")).statusCode).toBe(401);
    expect((await t.login(ALICE.password)).statusCode).toBe(200);
  });
});

describe("deleting one's own account after the password was verified, before an admin action", () => {
  it.each(["reset-password", "disable"] as const)("vs %s: 401 and the account survives", async (action) => {
    const t = await setup();
    t.duringVerify(t.adminDoes(action));
    const res = await t.call("DELETE", "/api/auth/account", t.alice.cookie, { password: ALICE.password });
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not signed in." }]);
    expect(await t.store.findUser("alice")).not.toBeNull();
  });
});

describe("sign out everywhere from a session read before an admin reset", () => {
  it("is refused, and the session the user started with the temporary password survives", async () => {
    const t = await setup();
    const aliceSession = sessionId(t.alice.cookie.slice("session=".length));
    let fresh = "";
    const read = t.store.findSession.bind(t.store);
    t.store.findSession = async (id: string) => {
      const found = await read(id);
      if (id === aliceSession && found) {
        t.store.findSession = read;
        await t.adminDoes("reset-password")();
        fresh = `session=${t.cookieOf(await t.login(t.temporary()))!.value}`;
      }
      return found;
    };
    const res = await t.call("POST", "/api/auth/logout-all", t.alice.cookie);
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not signed in." }]);
    expect((await t.call("GET", "/api/auth/me", fresh)).statusCode).toBe(200);
  });
});

describe("a password change from a session the user ended elsewhere meanwhile", () => {
  it("is refused once sign out everywhere on another device has run", async () => {
    const t = await setup();
    const other = `session=${t.cookieOf(await t.login(ALICE.password))!.value}`;
    t.duringVerify(async () => {
      expect((await t.call("POST", "/api/auth/logout-all", other)).statusCode).toBe(200);
    });
    const res = await t.call("POST", "/api/auth/password", t.alice.cookie, { currentPassword: ALICE.password, newPassword: "alice chosen password" });
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not signed in." }]);
    expect((await t.login(ALICE.password)).statusCode).toBe(200);
  });
});

describe("a login's answer", () => {
  it("takes must-change-password from the locked read at sign-in, not the record read before verifying", async () => {
    const t = await setup();
    // No action today flips the flag without changing the hash; flip it directly to pin where the answer comes from.
    t.duringVerify(async () => {
      const { users } = t.store as unknown as { users: Array<{ username: string; mustChangePassword: boolean }> };
      users.find((u) => u.username === "alice")!.mustChangePassword = true;
    });
    expect((await t.login(ALICE.password)).json()).toEqual({ user: { id: t.alice.id, username: "alice", mustChangePassword: true } });
  });
});

describe("MemoryStore's conditional writes", () => {
  const later = new Date(Date.now() + 86_400_000);
  async function user() {
    const store = new MemoryStore();
    const { id } = await store.createUser("alice", "h:old");
    await store.createSession("live", id, later);
    return { store, id };
  }

  it("refuse a stale password hash even while the asking session is live", async () => {
    const { store, id } = await user();
    expect(await store.changeOwnPassword(id, { sessionId: "live", passwordHash: "h:stale" }, "h:new", { id: "n", expiresAt: later })).toBe(false);
    expect(await store.deleteOwnAccount(id, { sessionId: "live", passwordHash: "h:stale" })).toBe(false);
    expect(await store.findUser("alice")).toMatchObject({ passwordHash: "h:old" });
    expect(await store.findSession("live")).not.toBeNull();
    expect(await store.findSession("n")).toBeNull();
  });

  it("refuse a session that no longer exists even with the current hash", async () => {
    const { store, id } = await user();
    const proof = { sessionId: "ended", passwordHash: "h:old" };
    expect(await store.changeOwnPassword(id, proof, "h:new", { id: "n", expiresAt: later })).toBe(false);
    expect(await store.deleteOwnAccount(id, proof)).toBe(false);
    expect(await store.endOwnSessions(id, "ended")).toBe(false);
    expect(await store.findSession("live")).not.toBeNull();
  });
});
