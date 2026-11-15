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
    expect(await store.findSession(id)).toEqual({ id, user, expiresAt });
    await store.deleteSession(id);
    expect(await store.findSession(id)).toBeNull();
  });

  it("changes a password replacing every session with a new one, ends all sessions, and deletes a user with theirs", async () => {
    const user = (await store.findUser(username))!;
    expect(await store.findUserById(user.id)).toEqual(user);
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);
    const [keep, a, b] = [0, 1, 2].map(() => randomBytes(32).toString("hex")) as [string, string, string];
    for (const id of [a, b]) await store.createSession(id, user.id, expiresAt);

    await store.setPassword(user.id, "new hash", { id: keep, expiresAt });
    expect((await store.findUserById(user.id))!.passwordHash).toBe("new hash");
    expect(await store.findSession(keep)).toEqual({ id: keep, user: { id: user.id, username: user.username }, expiresAt });
    expect(await store.findSession(a)).toBeNull();
    expect(await store.findSession(b)).toBeNull();

    await store.createSession(a, user.id, expiresAt);
    await store.deleteSessions(user.id);
    expect(await store.findSession(keep)).toBeNull();
    expect(await store.findSession(a)).toBeNull();

    await store.createSession(keep, user.id, expiresAt);
    await store.deleteUser(user.id);
    expect(await store.findUserById(user.id)).toBeNull();
    expect(await store.findSession(keep)).toBeNull();
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
    await store.recordSignIn(user.id, at);
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

    await store.setPassword(user.id, "own hash", null);
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
