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
    const { token, id, expiresAt } = this.newSession();
    const started = await this.store.startSignIn(user.id, passwordHash, { id, expiresAt }, new Date(this.now()));
    // Only an admin acting on the account in the moment since it was created gets here.
    if (!started.ok) throw new Error(`The new account was changed before it could sign in (${started.reason}).`);
    return { user, token, expiresAt };
  }

  /**
   * "disabled" only once the password has been verified, so it reveals nothing to someone without it: a wrong
   * password on a disabled account is "wrong" like any other. The session starts only if, at that moment, the
   * account still has the hash that was verified and isn't disabled; an admin action that landed during the verify
   * makes this answer what it would have had the login come after it.
   */
  async login(username: string, password: string) {
    const record = await this.store.findUser(username);
    // An unknown username still pays for one verify, so response time doesn't reveal which usernames exist.
    if (!this.dummyHash) throw new Error("Auth.init() must run before login.");
    const ok = await this.hasher.verify(record?.passwordHash ?? this.dummyHash, password);
    if (!record || !ok) return { kind: "wrong" } as const;
    if (record.disabled) return { kind: "disabled" } as const;
    const { token, id, expiresAt } = this.newSession();
    const started = await this.store.startSignIn(record.id, record.passwordHash, { id, expiresAt }, new Date(this.now()));
    if (!started.ok) return { kind: started.reason === "disabled" ? "disabled" : "wrong" } as const;
    const user = { id: record.id, username: record.username };
    return { kind: "ok", user, mustChangePassword: started.mustChangePassword, token, expiresAt } as const;
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

  /** The hash the password was verified against, which the write that follows must still find; null if wrong. */
  async checkPassword(userId: number, password: string): Promise<string | null> {
    const record = await this.store.findUserById(userId);
    return record && (await this.hasher.verify(record.passwordHash, password)) ? record.passwordHash : null;
  }

  /**
   * Ends every session of the user, the one that asked included, and returns a fresh one for the asking browser.
   * Null, and nothing changed, if the session or the verified hash stopped being current meanwhile.
   */
  async changePassword(session: Session, verifiedHash: string, password: string) {
    const passwordHash = await this.hasher.hash(password);
    const { token, id, expiresAt } = this.newSession();
    const done = await this.store.changeOwnPassword(session.user.id, { sessionId: session.id, passwordHash: verifiedHash }, passwordHash, { id, expiresAt });
    return done ? { token, expiresAt } : null;
  }

  async endAllSessions(session: Session) {
    return this.store.endOwnSessions(session.user.id, session.id);
  }

  async deleteOwnAccount(session: Session, verifiedHash: string) {
    return this.store.deleteOwnAccount(session.user.id, { sessionId: session.id, passwordHash: verifiedHash });
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

  private newSession() {
    const token = randomBytes(32).toString("base64url");
    return { token, id: sessionId(token), expiresAt: new Date(this.now() + SESSION_MS) };
  }
}
