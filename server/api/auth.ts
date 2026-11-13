import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { AuthStore, User } from "./store.js";

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export interface Hasher { hash(password: string): Promise<string>; verify(hash: string, password: string): Promise<boolean> }
export const argon2: Hasher = { hash: (p) => hash(p), verify: (h, p) => verify(h, p) };

export function sessionId(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class Auth {
  private dummyHash: Promise<string> | undefined;
  constructor(private store: AuthStore, private hasher: Hasher = argon2, private now = () => Date.now()) {}

  async signup(username: string, password: string) {
    const user = await this.store.createUser(username, await this.hasher.hash(password));
    return { user, ...(await this.startSession(user)) };
  }

  async login(username: string, password: string) {
    const record = await this.store.findUser(username);
    // An unknown username still pays for one verify, so response time doesn't reveal which usernames exist.
    this.dummyHash ??= this.hasher.hash(randomBytes(16).toString("hex"));
    const ok = await this.hasher.verify(record?.passwordHash ?? await this.dummyHash, password);
    if (!record || !ok) return null;
    const user = { id: record.id, username: record.username };
    return { user, ...(await this.startSession(user)) };
  }

  async userFor(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    const session = await this.store.findSession(sessionId(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.now()) {
      await this.store.deleteSession(session.id);
      return null;
    }
    return session.user;
  }

  async logout(token: string | undefined) {
    if (token) await this.store.deleteSession(sessionId(token));
  }

  private async startSession(user: User) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + SESSION_MS);
    await this.store.createSession(sessionId(token), user.id, expiresAt);
    return { token, expiresAt };
  }
}
