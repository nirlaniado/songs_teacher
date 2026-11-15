import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";
import { UsernameTaken, type AdminAction, type AdminChange, type AuthStore, type NewSession, type Proof, type SignIn } from "./store.js";

export function connect(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 5, connectTimeout: 3000 });
  // Drizzle reads and writes DATETIME as UTC, so the column defaults (CURRENT_TIMESTAMP) must be UTC too, whatever the server's zone.
  pool.on("connection", (c) => c.query("SET time_zone = '+00:00'"));
  return { pool, db: drizzle(pool, { schema, mode: "default" }) };
}

const { users, sessions, adminAudit } = schema;
const record = (row: typeof users.$inferSelect) => ({
  id: row.id, username: row.username, passwordHash: row.passwordHash, disabled: row.disabled, mustChangePassword: row.mustChangePassword,
});
/** `search` as a LIKE pattern (with `ESCAPE '!'`) matching it literally anywhere in the name. */
const containing = (search: string) => `%${search.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;

type Tx = Parameters<Parameters<ReturnType<typeof connect>["db"]["transaction"]>[0]>[0];

/** The user row, locked until the transaction ends. Every transaction that changes a user takes this lock first. */
async function lockUser(tx: Tx, userId: number) {
  const [row] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  return row ?? null;
}

/** The user, locked, if the asking session still exists and the verified hash is still current; otherwise null. */
async function proven(tx: Tx, userId: number, proof: Proof) {
  const user = await lockUser(tx, userId);
  if (!user || user.disabled || user.passwordHash !== proof.passwordHash) return null;
  const [live] = await tx.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.id, proof.sessionId), eq(sessions.userId, userId))).for("update");
  return live ? user : null;
}

export class MySqlStore implements AuthStore {
  constructor(private conn: ReturnType<typeof connect>) {}

  async createUser(username: string, passwordHash: string) {
    try {
      const [result] = await this.conn.db.insert(users).values({ username, passwordHash }).$returningId();
      return { id: result!.id, username };
    } catch (error) {
      if (isDuplicate(error)) throw new UsernameTaken();
      throw error;
    }
  }
  async findUser(username: string) {
    const [row] = await this.conn.db.select().from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`).limit(1);
    return row ? record(row) : null;
  }
  async findUserById(id: number) {
    const [row] = await this.conn.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? record(row) : null;
  }
  async startSignIn(userId: number, verifiedHash: string, session: NewSession, at: Date): Promise<SignIn> {
    return this.conn.db.transaction(async (tx) => {
      const user = await lockUser(tx, userId);
      if (!user) return { ok: false, reason: "gone" } as const;
      if (user.passwordHash !== verifiedHash) return { ok: false, reason: "changed" } as const;
      if (user.disabled) return { ok: false, reason: "disabled" } as const;
      await tx.insert(sessions).values({ id: session.id, userId, expiresAt: session.expiresAt });
      await tx.update(users).set({ lastSignInAt: at }).where(eq(users.id, userId));
      return { ok: true, mustChangePassword: user.mustChangePassword } as const;
    });
  }
  async changeOwnPassword(userId: number, proof: Proof, passwordHash: string, session: NewSession) {
    return this.conn.db.transaction(async (tx) => {
      if (!(await proven(tx, userId, proof))) return false;
      await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.insert(sessions).values({ id: session.id, userId, expiresAt: session.expiresAt });
      return true;
    });
  }
  async deleteOwnAccount(userId: number, proof: Proof) {
    return this.conn.db.transaction(async (tx) => {
      if (!(await proven(tx, userId, proof))) return false;
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
      return true;
    });
  }
  async endOwnSessions(userId: number, sessionId: string) {
    return this.conn.db.transaction(async (tx) => {
      if (!(await lockUser(tx, userId))) return false;
      const [live] = await tx.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId))).for("update");
      if (!live) return false;
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      return true;
    });
  }
  async setPassword(userId: number, passwordHash: string) {
    await this.conn.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    });
  }
  async createSession(id: string, userId: number, expiresAt: Date) {
    await this.conn.db.insert(sessions).values({ id, userId, expiresAt });
  }
  async findSession(id: string) {
    const [row] = await this.conn.db
      .select({
        id: sessions.id, expiresAt: sessions.expiresAt, userId: users.id, username: users.username,
        disabled: users.disabled, mustChangePassword: users.mustChangePassword,
      })
      .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id)).limit(1);
    return row
      ? { id: row.id, expiresAt: row.expiresAt, user: { id: row.userId, username: row.username }, disabled: row.disabled, mustChangePassword: row.mustChangePassword }
      : null;
  }
  async deleteSession(id: string) {
    await this.conn.db.delete(sessions).where(eq(sessions.id, id));
  }
  async listUsers({ search, limit, offset }: { search: string; limit: number; offset: number }) {
    const where = sql`lower(${users.username}) like ${containing(search)} escape '!'`;
    const rows = await this.conn.db
      .select({
        id: users.id, username: users.username, createdAt: users.createdAt, disabled: users.disabled,
        mustChangePassword: users.mustChangePassword, lastSignInAt: users.lastSignInAt,
      })
      .from(users).where(where).orderBy(asc(users.id)).limit(limit).offset(offset);
    const [total] = await this.conn.db.select({ n: count() }).from(users).where(where);
    return { items: rows, total: total?.n ?? 0 };
  }
  async adminChange(userId: number, change: AdminChange, at: Date) {
    return this.conn.db.transaction(async (tx) => {
      // Locks the row first, like every user write, so the action and its audit row see the same user and work
      // authorized before it either commits first or finds its proof gone.
      const locked = await lockUser(tx, userId);
      if (!locked) return null;
      const target = { id: locked.id, username: locked.username };
      if (change.action === "disable") await tx.update(users).set({ disabled: true }).where(eq(users.id, userId));
      if (change.action === "enable") await tx.update(users).set({ disabled: false }).where(eq(users.id, userId));
      if (change.action === "reset-password")
        await tx.update(users).set({ passwordHash: change.passwordHash, mustChangePassword: true }).where(eq(users.id, userId));
      if (change.action !== "enable") await tx.delete(sessions).where(eq(sessions.userId, userId));
      if (change.action === "delete") await tx.delete(users).where(eq(users.id, userId));
      await tx.insert(adminAudit).values({ at, action: change.action, targetUserId: target.id, targetUsername: target.username });
      return target;
    });
  }
  async listAudit({ limit, offset }: { limit: number; offset: number }) {
    const rows = await this.conn.db.select().from(adminAudit).orderBy(desc(adminAudit.id)).limit(limit).offset(offset);
    const [total] = await this.conn.db.select({ n: count() }).from(adminAudit);
    return { items: rows.map((r) => ({ ...r, action: r.action as AdminAction })), total: total?.n ?? 0 };
  }
  async ping() {
    await this.conn.pool.query("SELECT 1");
  }
}

function isDuplicate(error: unknown): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause)
    if ((e as { code?: string }).code === "ER_DUP_ENTRY") return true;
  return false;
}
