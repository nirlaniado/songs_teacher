import { sql } from "drizzle-orm";
import { bigint, datetime, index, mysqlTable, serial, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 32 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  createdAt: datetime("created_at", { mode: "date" }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  // A functional index makes uniqueness ignore case whatever the server's default collation is.
  uniqueIndex("users_username_lower_unique").on(sql`(lower(${t.username}))`),
]);

export const sessions = mysqlTable("sessions", {
  // SHA-256 of the cookie token, so a leaked table can't be replayed as live sessions.
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: bigint("user_id", { mode: "number", unsigned: true }).notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  createdAt: datetime("created_at", { mode: "date" }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("sessions_user_id_idx").on(t.userId)]);
