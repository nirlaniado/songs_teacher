import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";
import { UsernameTaken, type AuthStore } from "./store.js";

export function connect(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 5, connectTimeout: 3000 });
  return { pool, db: drizzle(pool, { schema, mode: "default" }) };
}

export class MySqlStore implements AuthStore {
  constructor(private conn: ReturnType<typeof connect>) {}

  async createUser(username: string, passwordHash: string) {
    try {
      const [result] = await this.conn.db.insert(schema.users).values({ username, passwordHash }).$returningId();
      return { id: result!.id, username };
    } catch (error) {
      if (isDuplicate(error)) throw new UsernameTaken();
      throw error;
    }
  }
  async findUser(username: string) {
    const [row] = await this.conn.db.select().from(schema.users)
      .where(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`).limit(1);
    return row ? { id: row.id, username: row.username, passwordHash: row.passwordHash } : null;
  }
  async findUserById(id: number) {
    const [row] = await this.conn.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row ? { id: row.id, username: row.username, passwordHash: row.passwordHash } : null;
  }
  async setPassword(userId: number, passwordHash: string, keepSessionId: string) {
    await this.conn.db.transaction(async (tx) => {
      await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
      await tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)));
    });
  }
  async deleteSessions(userId: number) {
    await this.conn.db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  }
  async deleteUser(userId: number) {
    await this.conn.db.transaction(async (tx) => {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
  }
  async createSession(id: string, userId: number, expiresAt: Date) {
    await this.conn.db.insert(schema.sessions).values({ id, userId, expiresAt });
  }
  async findSession(id: string) {
    const [row] = await this.conn.db
      .select({ id: schema.sessions.id, expiresAt: schema.sessions.expiresAt, userId: schema.users.id, username: schema.users.username })
      .from(schema.sessions).innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.id, id)).limit(1);
    return row ? { id: row.id, expiresAt: row.expiresAt, user: { id: row.userId, username: row.username } } : null;
  }
  async deleteSession(id: string) {
    await this.conn.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
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
