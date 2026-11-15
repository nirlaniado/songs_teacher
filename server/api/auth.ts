import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { UsernameTaken, type AdminChange, type AuthStore, type User } from "./store.js";

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export interface Hasher { hash(password: string): Promise<string>; verify(hash: string, password: string): Promise<boolean> }
export const argon2: Hasher = { hash: (p) => hash(p), verify: (h, p) => verify(h, p) };

export interface Session { id: string; user: User; mustChangePassword: boolean }

export function sessionId(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class Auth {
  private dummyHash: string | undefined;
  constructor(private store: AuthStore, private hasher: Hasher = argon2, private now = () => Date.now()) {}

  /** Computes the dummy hash up front, so the first unknown-username login does no extra work. */
  async init() {
    this.dummyHash ??= await this.hasher.hash(randomBytes(16).toString("hex"));
  }

  /**
   * A `reserved` name is refused as taken after the same work, one hash and one lookup, so neither answer nor timing
   * tells it apart. createUser still refuses a duplicate that lands between the lookup and the insert.
   */
  async signup(username: string, password: string, reserved = false) {
    const passwordHash = await this.hasher.hash(password);
    const existing = await this.store.findUser(username);
    if (reserved || existing) throw new UsernameTaken();
    const user = await this.store.createUser(username, passwordHash);
    return { user, ...(await this.startSession(user)) };
  }

  /**
   * "disabled" only once the password has been verified, so it reveals nothing to someone without it: a wrong
   * password on a disabled account is "wrong" like any other.
   */
  async login(username: string, password: string) {
    const record = await this.store.findUser(username);
    // An unknown username still pays for one verify, so response time doesn't reveal which usernames exist.
    if (!this.dummyHash) throw new Error("Auth.init() must run before login.");
    const ok = await this.hasher.verify(record?.passwordHash ?? this.dummyHash, password);
    if (!record || !ok) return { kind: "wrong" } as const;
    if (record.disabled) return { kind: "disabled" } as const;
    const user = { id: record.id, username: record.username };
    return { kind: "ok", user, mustChangePassword: record.mustChangePassword, ...(await this.startSession(user)) } as const;
  }

  async userFor(token: string | undefined): Promise<User | null> {
    return (await this.sessionFor(token))?.user ?? null;
  }

  /** A disabled user's session counts for nothing, even one that slipped in while the account was being disabled. */
  async sessionFor(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const session = await this.store.findSession(sessionId(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.now()) {
      await this.store.deleteSession(session.id);
      return null;
    }
    if (session.disabled) return null;
    return { id: session.id, user: session.user, mustChangePassword: session.mustChangePassword };
  }

  async checkPassword(userId: number, password: string): Promise<boolean> {
    const record = await this.store.findUserById(userId);
    return !!record && (await this.hasher.verify(record.passwordHash, password));
  }

  /** Ends every session of the user, the one that asked included, and returns a fresh one for the asking browser. */
  async changePassword(user: User, password: string) {
    const passwordHash = await this.hasher.hash(password);
    const { token, id, expiresAt } = this.newSession();
    await this.store.setPassword(user.id, passwordHash, { id, expiresAt });
    return { token, expiresAt };
  }

  async endAllSessions(userId: number) {
    await this.store.deleteSessions(userId);
  }

  async deleteUser(userId: number) {
    await this.store.deleteUser(userId);
  }

  async logout(token: string | undefined) {
    if (token) await this.store.deleteSession(sessionId(token));
  }

  /** A strong temporary password, returned once to the admin; it is stored only as a hash. */
  async resetPassword(userId: number) {
    const temporaryPassword = randomBytes(18).toString("base64url");
    const user = await this.store.adminChange(userId, { action: "reset-password", passwordHash: await this.hasher.hash(temporaryPassword) }, new Date(this.now()));
    return user && { user, temporaryPassword };
  }

  async adminChange(userId: number, change: Exclude<AdminChange, { action: "reset-password" }>) {
    return this.store.adminChange(userId, change, new Date(this.now()));
  }

  private async startSession(user: User) {
    const { token, id, expiresAt } = this.newSession();
    await this.store.createSession(id, user.id, expiresAt);
    await this.store.recordSignIn(user.id, new Date(this.now()));
    return { token, expiresAt };
  }

  private newSession() {
    const token = randomBytes(32).toString("base64url");
    return { token, id: sessionId(token), expiresAt: new Date(this.now() + SESSION_MS) };
  }
}
