import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { databaseUrl } from "./config";
import { connect, MySqlStore } from "./db";
import { UsernameTaken } from "./store";

const url = databaseUrl();

// Runs only against a real, migrated database (`npm run api:migrate`), and only when DATABASE_URL is set.
describe.skipIf(!url)("MySqlStore", () => {
  const conn = url ? connect(url) : null!;
  const store = url ? new MySqlStore(conn) : null!;
  const username = `t_${randomBytes(6).toString("hex")}`;

  afterAll(async () => {
    await conn.db.execute(sql`DELETE FROM users WHERE lower(username) = ${username.toLowerCase()}`);
    await conn.pool.end();
  });

  it("creates users, enforces case-insensitive uniqueness and round-trips sessions", async () => {
    await store.ping();
    const user = await store.createUser(username, "hash");
    await expect(store.createUser(username.toUpperCase(), "hash")).rejects.toBeInstanceOf(UsernameTaken);
    expect(await store.findUser(username.toUpperCase())).toMatchObject({ id: user.id, passwordHash: "hash" });

    const id = randomBytes(32).toString("hex");
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);
    await store.createSession(id, user.id, expiresAt);
    expect(await store.findSession(id)).toEqual({ id, user, expiresAt, disabled: false, mustChangePassword: false });
    await store.deleteSession(id);
    expect(await store.findSession(id)).toBeNull();
  });

  it("signs in, changes its own password, ends its sessions and deletes itself, each only with live proof", async () => {
    const user = (await store.findUser(username))!;
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const [s1, s2, s3, s4] = [0, 1, 2, 3].map(() => randomBytes(32).toString("hex")) as [string, string, string, string];

    expect(await store.startSignIn(user.id, "hash", { id: s1, expiresAt }, at)).toEqual({ ok: true, mustChangePassword: false });
    expect(await store.startSignIn(user.id, "hash", { id: s2, expiresAt }, at)).toEqual({ ok: true, mustChangePassword: false });
    expect(await store.startSignIn(user.id, "not the hash", { id: s3, expiresAt }, at)).toEqual({ ok: false, reason: "changed" });
    expect(await store.findSession(s3)).toBeNull();

    expect(await store.changeOwnPassword(user.id, { sessionId: s1, passwordHash: "hash" }, "new hash", { id: s3, expiresAt })).toBe(true);
    expect((await store.findUserById(user.id))!.passwordHash).toBe("new hash");
    expect(await store.findSession(s3)).toMatchObject({ id: s3, user: { id: user.id } });
    for (const gone of [s1, s2]) expect(await store.findSession(gone)).toBeNull();

    await store.createSession(s4, user.id, expiresAt);
    expect(await store.endOwnSessions(user.id, s3)).toBe(true);
    expect(await store.findSession(s4)).toBeNull();
    expect(await store.endOwnSessions(user.id, s3)).toBe(false);

    expect(await store.startSignIn(user.id, "new hash", { id: s1, expiresAt }, at)).toEqual({ ok: true, mustChangePassword: false });
    expect(await store.deleteOwnAccount(user.id, { sessionId: s1, passwordHash: "new hash" })).toBe(true);
    expect(await store.findUserById(user.id)).toBeNull();
    expect(await store.findSession(s1)).toBeNull();
  });
});

describe.skipIf(!url)("MySqlStore admin", () => {
  const conn = url ? connect(url) : null!;
  const store = url ? new MySqlStore(conn) : null!;
  // Names share a random prefix, so the listing can be searched for this run's rows alone.
  const prefix = `a${randomBytes(4).toString("hex")}`;
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  const sid = () => randomBytes(32).toString("hex");

  afterAll(async () => {
    await conn.db.execute(sql`DELETE FROM users WHERE username LIKE ${`${prefix}%`}`);
    await conn.db.execute(sql`DELETE FROM admin_audit WHERE target_username LIKE ${`${prefix}%`}`);
    await conn.pool.end();
  });

  it("stores the new columns with their defaults and records sign-ins", async () => {
    const user = await store.createUser(`${prefix}_new`, "hash");
    expect(await store.findUserById(user.id)).toEqual({ ...user, passwordHash: "hash", disabled: false, mustChangePassword: false });
    expect(await store.startSignIn(user.id, "hash", { id: sid(), expiresAt: later }, at)).toEqual({ ok: true, mustChangePassword: false });
    const { items } = await store.listUsers({ search: `${prefix}_new`, limit: 10, offset: 0 });
    expect(items).toEqual([{ ...user, createdAt: expect.any(Date), disabled: false, mustChangePassword: false, lastSignInAt: at }]);
  });

  it("lists by id, pages, and searches ignoring case with % and _ taken literally", async () => {
    for (const name of ["b_x", "bax", "B%y"]) await store.createUser(`${prefix}${name}`, "hash");
    const names = async (search: string, limit = 10, offset = 0) => {
      const page = await store.listUsers({ search, limit, offset });
      return [page.total, page.items.map((u) => u.username.slice(prefix.length))];
    };
    expect(await names(`${prefix}b`)).toEqual([3, ["b_x", "bax", "B%y"]]);
    expect(await names(`${prefix}b`, 1, 1)).toEqual([3, ["bax"]]);
    expect(await names(`${prefix}b_`)).toEqual([1, ["b_x"]]);
    expect(await names(`${prefix}B%`)).toEqual([1, ["B%y"]]);
  });

  it("applies each admin action with its audit row, ending sessions where it should", async () => {
    const user = await store.createUser(`${prefix}_t`, "hash");
    const open = async () => { const id = sid(); await store.createSession(id, user.id, later); return id; };

    let s = await open();
    expect(await store.adminChange(user.id, { action: "disable" }, at)).toEqual(user);
    expect(await store.findUserById(user.id)).toMatchObject({ disabled: true });
    expect(await store.findSession(s)).toBeNull();

    s = await open();
    await store.adminChange(user.id, { action: "enable" }, at);
    expect(await store.findSession(s)).toMatchObject({ disabled: false, mustChangePassword: false });

    await store.adminChange(user.id, { action: "reset-password", passwordHash: "temp hash" }, at);
    expect(await store.findUserById(user.id)).toMatchObject({ passwordHash: "temp hash", mustChangePassword: true });
    expect(await store.findSession(s)).toBeNull();

    await store.setPassword(user.id, "own hash");
    expect(await store.findUserById(user.id)).toMatchObject({ passwordHash: "own hash", mustChangePassword: false });

    s = await open();
    await store.adminChange(user.id, { action: "delete" }, at);
    expect(await store.findUserById(user.id)).toBeNull();
    expect(await store.findSession(s)).toBeNull();
    expect(await store.adminChange(user.id, { action: "disable" }, at)).toBeNull();

    const { items } = await store.listAudit({ limit: 1000, offset: 0 });
    const mine = items.filter((r) => r.targetUsername === `${prefix}_t`);
    expect(mine.map((r) => [r.action, r.targetUserId, r.at])).toEqual(
      ["delete", "reset-password", "enable", "disable"].map((a) => [a, user.id, at]),
    );
  });
});

// The interleavings from race.test.ts, against MySQL: the hash is read and "verified", the admin action commits,
// and only then does the user's conditional write run. It must find its proof gone and write nothing.
describe.skipIf(!url)("MySqlStore: work authorized before an admin action", () => {
  const conn = url ? connect(url) : null!;
  const store = url ? new MySqlStore(conn) : null!;
  const prefix = `r${randomBytes(4).toString("hex")}`;
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  const sid = () => randomBytes(32).toString("hex");
  let n = 0;

  afterAll(async () => {
    await conn.db.execute(sql`DELETE FROM users WHERE username LIKE ${`${prefix}%`}`);
    await conn.db.execute(sql`DELETE FROM admin_audit WHERE target_username LIKE ${`${prefix}%`}`);
    await conn.pool.end();
  });

  /** A user with one live session, and the hash a request would have verified. */
  async function signedIn() {
    const user = await store.createUser(`${prefix}_${++n}`, "old hash");
    const session = sid();
    expect(await store.startSignIn(user.id, "old hash", { id: session, expiresAt: later }, at)).toEqual({ ok: true, mustChangePassword: false });
    const verified = (await store.findUserById(user.id))!.passwordHash;
    return { user, session, verified, proof: { sessionId: session, passwordHash: verified } };
  }
  const sessionsOf = async (userId: number) =>
    (await conn.db.execute(sql`SELECT id FROM sessions WHERE user_id = ${userId}`))[0] as unknown as unknown[];

  it("login vs disable: no session starts", async () => {
    const { user, verified } = await signedIn();
    await store.adminChange(user.id, { action: "disable" }, at);
    expect(await store.startSignIn(user.id, verified, { id: sid(), expiresAt: later }, at)).toEqual({ ok: false, reason: "disabled" });
    expect(await sessionsOf(user.id)).toEqual([]);
  });

  it("login vs reset: no session starts", async () => {
    const { user, verified } = await signedIn();
    await store.adminChange(user.id, { action: "reset-password", passwordHash: "temp hash" }, at);
    expect(await store.startSignIn(user.id, verified, { id: sid(), expiresAt: later }, at)).toEqual({ ok: false, reason: "changed" });
    expect(await sessionsOf(user.id)).toEqual([]);
  });

  it("login vs delete: no session starts", async () => {
    const { user, verified } = await signedIn();
    await store.adminChange(user.id, { action: "delete" }, at);
    expect(await store.startSignIn(user.id, verified, { id: sid(), expiresAt: later }, at)).toEqual({ ok: false, reason: "gone" });
  });

  it("password change vs reset: nothing written, the reset stands", async () => {
    const { user, proof } = await signedIn();
    await store.adminChange(user.id, { action: "reset-password", passwordHash: "temp hash" }, at);
    expect(await store.changeOwnPassword(user.id, proof, "chosen hash", { id: sid(), expiresAt: later })).toBe(false);
    expect(await store.findUserById(user.id)).toMatchObject({ passwordHash: "temp hash", mustChangePassword: true });
    expect(await sessionsOf(user.id)).toEqual([]);
  });

  it("password change vs disable: nothing written, still disabled", async () => {
    const { user, proof } = await signedIn();
    await store.adminChange(user.id, { action: "disable" }, at);
    expect(await store.changeOwnPassword(user.id, proof, "chosen hash", { id: sid(), expiresAt: later })).toBe(false);
    expect(await store.findUserById(user.id)).toMatchObject({ passwordHash: "old hash", disabled: true });
    expect(await sessionsOf(user.id)).toEqual([]);
  });

  it("own deletion vs reset, and sign out everywhere from an ended session, are refused", async () => {
    const { user, proof, session } = await signedIn();
    await store.adminChange(user.id, { action: "reset-password", passwordHash: "temp hash" }, at);
    expect(await store.deleteOwnAccount(user.id, proof)).toBe(false);
    expect(await store.findUserById(user.id)).not.toBeNull();
    const fresh = sid();
    expect(await store.startSignIn(user.id, "temp hash", { id: fresh, expiresAt: later }, at)).toEqual({ ok: true, mustChangePassword: true });
    expect(await store.endOwnSessions(user.id, session)).toBe(false);
    expect(await store.findSession(fresh)).not.toBeNull();
  });

  it("a stale hash is refused even while the session is live", async () => {
    const { user, session } = await signedIn();
    const stale = { sessionId: session, passwordHash: "stale hash" };
    expect(await store.changeOwnPassword(user.id, stale, "chosen hash", { id: sid(), expiresAt: later })).toBe(false);
    expect(await store.deleteOwnAccount(user.id, stale)).toBe(false);
    expect(await store.findSession(session)).not.toBeNull();
  });
});
