export interface User { id: number; username: string }
export interface UserRecord extends User { passwordHash: string }
export interface SessionRecord { id: string; user: User; expiresAt: Date }

export class UsernameTaken extends Error {}

/** Everything auth needs from storage. MySQL in production, an in-memory fake in tests. */
export interface AuthStore {
  createUser(username: string, passwordHash: string): Promise<User>;
  findUser(username: string): Promise<UserRecord | null>;
  createSession(id: string, userId: number, expiresAt: Date): Promise<void>;
  findSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  ping(): Promise<void>;
}

export class MemoryStore implements AuthStore {
  private users: UserRecord[] = [];
  private sessions = new Map<string, { userId: number; expiresAt: Date }>();
  down = false;

  async createUser(username: string, passwordHash: string) {
    this.check();
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new UsernameTaken();
    const user = { id: this.users.length + 1, username, passwordHash };
    this.users.push(user);
    return { id: user.id, username };
  }
  async findUser(username: string) {
    this.check();
    return this.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
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
