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
});
