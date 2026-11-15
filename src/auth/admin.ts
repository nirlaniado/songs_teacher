import { z } from "zod";
import { request } from "./client.js";

// The admin's API over HTTP (server/api, /api/admin). Shapes restated, not imported (hard rule 10).
const AccountRow = z.object({
  id: z.number(),
  username: z.string(),
  createdAt: z.string(),
  lastSignInAt: z.string().nullable(),
  disabled: z.boolean(),
  mustChangePassword: z.boolean(),
  admin: z.boolean(),
});
export type AccountRow = z.infer<typeof AccountRow>;
const UserPage = z.object({ users: z.array(AccountRow), total: z.number(), page: z.number(), perPage: z.number() });
export type UserPage = z.infer<typeof UserPage>;

const AuditEntry = z.object({ id: z.number(), at: z.string(), action: z.string(), targetUserId: z.number(), targetUsername: z.string() });
export type AuditEntry = z.infer<typeof AuditEntry>;
const AuditPage = z.object({ entries: z.array(AuditEntry), total: z.number(), page: z.number(), perPage: z.number() });
export type AuditPage = z.infer<typeof AuditPage>;

export const PER_PAGE = 25;

export const listUsers = (search: string, page: number) =>
  request("GET", `/api/admin/users?${new URLSearchParams({ search, page: String(page), perPage: String(PER_PAGE) })}`, UserPage);
export const listAudit = (page: number) =>
  request("GET", `/api/admin/audit?${new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) })}`, AuditPage);
export const setDisabled = (id: number, disabled: boolean) =>
  request("POST", `/api/admin/users/${id}/${disabled ? "disable" : "enable"}`, z.unknown());
export const resetPassword = (id: number) =>
  request("POST", `/api/admin/users/${id}/reset-password`, z.object({ temporaryPassword: z.string() }));
export const deleteUser = (id: number) => request("DELETE", `/api/admin/users/${id}`, z.unknown());
