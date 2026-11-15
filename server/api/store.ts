export interface User { id: number; username: string }
export interface UserRecord extends User { passwordHash: string; disabled: boolean; mustChangePassword: boolean }
export interface SessionRecord { id: string; user: User; expiresAt: Date; disabled: boolean; mustChangePassword: boolean }
/** A user as the admin's list shows them. */
export interface UserRow extends User { createdAt: Date; disabled: boolean; mustChangePassword: boolean; lastSignInAt: Date | null }
export type AdminChange =
  | { action: "disable" }
  | { action: "enable" }
  | { action: "reset-password"; passwordHash: string }
  | { action: "delete" };
export type AdminAction = AdminChange["action"];
export interface AuditRow { id: number; at: Date; action: AdminAction; targetUserId: number; targetUsername: string }
export interface Page<T> { items: T[]; total: number }

export class UsernameTaken extends Error {}

/** Everything auth needs from storage. MySQL in production, an in-memory fake in tests. */
export interface AuthStore {
  createUser(username: string, passwordHash: string): Promise<User>;
  findUser(username: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  /**
   * Replaces the password hash, clears must-change-password and ends every session of that user, then starts
   * `session` for them if given, all together.
   */
  setPassword(userId: number, passwordHash: string, session: { id: string; expiresAt: Date } | null): Promise<void>;
  recordSignIn(userId: number, at: Date): Promise<void>;
  deleteSessions(userId: number): Promise<void>;
  /** Deletes the user and every session of theirs. */
  deleteUser(userId: number): Promise<void>;
  createSession(id: string, userId: number, expiresAt: Date): Promise<void>;
  findSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  /** Usernames containing `search`, ignoring case, by id. */
  listUsers(query: { search: string; limit: number; offset: number }): Promise<Page<UserRow>>;
  /**
   * Applies one admin action to a user and writes its audit row, together. Disable, reset and delete also end every
   * session of the user. Null, and nothing written, if the user no longer exists.
   */
  adminChange(userId: number, change: AdminChange, at: Date): Promise<User | null>;
  /** Newest first. */
  listAudit(query: { limit: number; offset: number }): Promise<Page<AuditRow>>;
  ping(): Promise<void>;
}

export class MemoryStore implements AuthStore {
  private users: Array<UserRecord & { createdAt: Date; lastSignInAt: Date | null }> = [];
  private lastId = 0;
  private sessions = new Map<string, { userId: number; expiresAt: Date }>();
  private audit: AuditRow[] = [];
  down = false;
  constructor(private now = () => new Date()) {}

  async createUser(username: string, passwordHash: string) {
    this.check();
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new UsernameTaken();
    const user = { id: ++this.lastId, username, passwordHash, disabled: false, mustChangePassword: false, createdAt: this.now(), lastSignInAt: null };
    this.users.push(user);
    return { id: user.id, username };
  }
  async findUser(username: string) {
    this.check();
    return record(this.users.find((u) => u.username.toLowerCase() === username.toLowerCase()));
  }
  async findUserById(id: number) {
    this.check();
    return record(this.users.find((u) => u.id === id));
  }
  async setPassword(userId: number, passwordHash: string, session: { id: string; expiresAt: Date } | null) {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (user) Object.assign(user, { passwordHash, mustChangePassword: false });
    this.endSessions(userId);
    if (session) this.sessions.set(session.id, { userId, expiresAt: session.expiresAt });
  }
  async recordSignIn(userId: number, at: Date) {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (user) user.lastSignInAt = at;
  }
  async deleteSessions(userId: number) {
    this.check();
    this.endSessions(userId);
  }
  async deleteUser(userId: number) {
    this.check();
    this.users = this.users.filter((u) => u.id !== userId);
    this.endSessions(userId);
  }
  async createSession(id: string, userId: number, expiresAt: Date) {
    this.check();
    this.sessions.set(id, { userId, expiresAt });
  }
  async findSession(id: string) {
    this.check();
    const s = this.sessions.get(id);
    const u = s && this.users.find((x) => x.id === s.userId);
    return s && u
      ? { id, user: { id: u.id, username: u.username }, expiresAt: s.expiresAt, disabled: u.disabled, mustChangePassword: u.mustChangePassword }
      : null;
  }
  async deleteSession(id: string) {
    this.check();
    this.sessions.delete(id);
  }
  async listUsers({ search, limit, offset }: { search: string; limit: number; offset: number }) {
    this.check();
    const matching = this.users.filter((u) => u.username.toLowerCase().includes(search.toLowerCase()));
    const items = matching.slice(offset, offset + limit).map(({ passwordHash: _h, ...row }) => ({ ...row }));
    return { items, total: matching.length };
  }
  async adminChange(userId: number, change: AdminChange, at: Date) {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (!user) return null;
    if (change.action === "disable") user.disabled = true;
    if (change.action === "enable") user.disabled = false;
    if (change.action === "reset-password") Object.assign(user, { passwordHash: change.passwordHash, mustChangePassword: true });
    if (change.action === "delete") this.users = this.users.filter((u) => u.id !== userId);
    if (change.action !== "enable") this.endSessions(userId);
    this.audit.push({ id: this.audit.length + 1, at, action: change.action, targetUserId: user.id, targetUsername: user.username });
    return { id: user.id, username: user.username };
  }
  async listAudit({ limit, offset }: { limit: number; offset: number }) {
    this.check();
    return { items: [...this.audit].reverse().slice(offset, offset + limit).map((row) => ({ ...row })), total: this.audit.length };
  }
  async ping() { this.check(); }
  sessionCount() { return this.sessions.size; }
  private endSessions(userId: number) {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
  private check() { if (this.down) throw new Error("database unreachable"); }
}

function record(u: (UserRecord & { createdAt: Date; lastSignInAt: Date | null }) | undefined): UserRecord | null {
  return u ? { id: u.id, username: u.username, passwordHash: u.passwordHash, disabled: u.disabled, mustChangePassword: u.mustChangePassword } : null;
}
