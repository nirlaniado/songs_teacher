import { z } from "zod";

export const NewPassword = z.string().min(10, "Password must be at least 10 characters.").max(1024);
const AnyPassword = z.string().max(1024);

export const Credentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/, "Username must be 3–32 letters, digits, _ or -."),
  password: NewPassword,
}).strict();
export type Credentials = z.infer<typeof Credentials>;

export const PasswordChange = z.object({ currentPassword: AnyPassword, newPassword: NewPassword }).strict();
export const AccountDeletion = z.object({ password: AnyPassword }).strict();

const Paging = { page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(100).default(50) };
export const UserListQuery = z.object({ ...Paging, search: z.string().max(32).default("") }).strict();
export const AuditQuery = z.object(Paging).strict();
export const UserId = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
