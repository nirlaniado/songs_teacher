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
/** What authorized a self-service write: the session that asked and the password hash that was just verified. */
export interface Proof { sessionId: string; passwordHash: string }
export interface NewSession { id: string; expiresAt: Date }
export type SignIn = { ok: true; mustChangePassword: boolean } | { ok: false; reason: "gone" | "changed" | "disabled" };

export class UsernameTaken extends Error {}

/** Everything auth needs from storage. MySQL in production, an in-memory fake in tests. */
export interface AuthStore {
  createUser(username: string, passwordHash: string): Promise<User>;
  findUser(username: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  // The conditional writes below each lock the user row and check, under that lock, that what authorized them is
  // still current. An admin action takes the same lock, so whichever commits second sees the other's result: work
  // authorized before a disable, reset or delete can't land after it.

  /**
   * Starts a session and records the sign-in, only if the user still exists, still has the password hash that was
   * verified, and isn't disabled. The flags returned come from that same locked read.
   */
  startSignIn(userId: number, verifiedHash: string, session: NewSession, at: Date): Promise<SignIn>;
  /**
   * Only if the asking session still exists and the verified hash is still current: replaces the hash, clears
   * must-change-password, ends every session of the user and starts `session`. False, and nothing written, otherwise.
   */
  changeOwnPassword(userId: number, proof: Proof, passwordHash: string, session: NewSession): Promise<boolean>;
  /** Deletes the user and their sessions, on the same condition as changeOwnPassword. */
  deleteOwnAccount(userId: number, proof: Proof): Promise<boolean>;
  /** Ends every session of the user, only if the asking session still exists. */
  endOwnSessions(userId: number, sessionId: string): Promise<boolean>;
  /** The console's reset (api:make-admin): replaces the hash, clears must-change-password, ends every session. */
  setPassword(userId: number, passwordHash: string): Promise<void>;
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
  // Each conditional write runs without an await between its check and its write, which is what the MySQL
  // store's row lock gives it there.
  async startSignIn(userId: number, verifiedHash: string, session: NewSession, at: Date): Promise<SignIn> {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (!user) return { ok: false, reason: "gone" };
    if (user.passwordHash !== verifiedHash) return { ok: false, reason: "changed" };
    if (user.disabled) return { ok: false, reason: "disabled" };
    this.sessions.set(session.id, { userId, expiresAt: session.expiresAt });
    user.lastSignInAt = at;
    return { ok: true, mustChangePassword: user.mustChangePassword };
  }
  async changeOwnPassword(userId: number, proof: Proof, passwordHash: string, session: NewSession) {
    this.check();
    const user = this.proven(userId, proof);
    if (!user) return false;
    Object.assign(user, { passwordHash, mustChangePassword: false });
    this.endSessions(userId);
    this.sessions.set(session.id, { userId, expiresAt: session.expiresAt });
    return true;
  }
  async deleteOwnAccount(userId: number, proof: Proof) {
    this.check();
    if (!this.proven(userId, proof)) return false;
    this.users = this.users.filter((u) => u.id !== userId);
    this.endSessions(userId);
    return true;
  }
  async endOwnSessions(userId: number, sessionId: string) {
    this.check();
    if (this.sessions.get(sessionId)?.userId !== userId) return false;
    this.endSessions(userId);
    return true;
  }
  async setPassword(userId: number, passwordHash: string) {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (user) Object.assign(user, { passwordHash, mustChangePassword: false });
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
  private proven(userId: number, proof: Proof) {
    const user = this.users.find((u) => u.id === userId);
    const live = this.sessions.get(proof.sessionId)?.userId === userId;
    return user && live && !user.disabled && user.passwordHash === proof.passwordHash ? user : null;
  }
  private endSessions(userId: number) {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
  private check() { if (this.down) throw new Error("database unreachable"); }
}

function record(u: (UserRecord & { createdAt: Date; lastSignInAt: Date | null }) | undefined): UserRecord | null {
  return u ? { id: u.id, username: u.username, passwordHash: u.passwordHash, disabled: u.disabled, mustChangePassword: u.mustChangePassword } : null;
}
