export interface User { id: number; username: string }
export interface UserRecord extends User { passwordHash: string }
export interface SessionRecord { id: string; user: User; expiresAt: Date }

export class UsernameTaken extends Error {}

/** Everything auth needs from storage. MySQL in production, an in-memory fake in tests. */
export interface AuthStore {
  createUser(username: string, passwordHash: string): Promise<User>;
  findUser(username: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  /** Replaces the password hash, ends every session of that user and starts `session` for them, all together. */
  setPassword(userId: number, passwordHash: string, session: { id: string; expiresAt: Date }): Promise<void>;
  deleteSessions(userId: number): Promise<void>;
  /** Deletes the user and every session of theirs. */
  deleteUser(userId: number): Promise<void>;
  createSession(id: string, userId: number, expiresAt: Date): Promise<void>;
  findSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  ping(): Promise<void>;
}

export class MemoryStore implements AuthStore {
  private users: UserRecord[] = [];
  private lastId = 0;
  private sessions = new Map<string, { userId: number; expiresAt: Date }>();
  down = false;

  async createUser(username: string, passwordHash: string) {
    this.check();
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new UsernameTaken();
    const user = { id: ++this.lastId, username, passwordHash };
    this.users.push(user);
    return { id: user.id, username };
  }
  async findUser(username: string) {
    this.check();
    return this.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
  }
  async findUserById(id: number) {
    this.check();
    return this.users.find((u) => u.id === id) ?? null;
  }
  async setPassword(userId: number, passwordHash: string, session: { id: string; expiresAt: Date }) {
    this.check();
    const user = this.users.find((u) => u.id === userId);
    if (user) user.passwordHash = passwordHash;
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
    this.sessions.set(session.id, { userId, expiresAt: session.expiresAt });
  }
  async deleteSessions(userId: number) {
    this.check();
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
  async deleteUser(userId: number) {
    this.check();
    this.users = this.users.filter((u) => u.id !== userId);
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }
  async createSession(id: string, userId: number, expiresAt: Date) {
    this.check();
    this.sessions.set(id, { userId, expiresAt });
  }
  async findSession(id: string) {
    this.check();
    const s = this.sessions.get(id);
    const u = s && this.users.find((x) => x.id === s.userId);
    return s && u ? { id, user: { id: u.id, username: u.username }, expiresAt: s.expiresAt } : null;
  }
  async deleteSession(id: string) {
    this.check();
    this.sessions.delete(id);
  }
  async ping() { this.check(); }
  sessionCount() { return this.sessions.size; }
  private check() { if (this.down) throw new Error("database unreachable"); }
}
