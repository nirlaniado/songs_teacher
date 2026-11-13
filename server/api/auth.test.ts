import { describe, expect, it } from "vitest";
import { argon2, Auth, sessionId, type Hasher } from "./auth";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };

describe("Auth", () => {
  it("stores only a hash of the session token", async () => {
    const store = new MemoryStore();
    const { token } = await new Auth(store, plain).signup("alice", "password123");
    expect(await store.findSession(token)).toBeNull();
    expect(await store.findSession(sessionId(token))).not.toBeNull();
  });

  it("expires a session after 30 days and deletes its row", async () => {
    const store = new MemoryStore();
    let now = Date.UTC(2026, 0, 1);
    const auth = new Auth(store, plain, () => now);
    const { token, expiresAt } = await auth.signup("alice", "password123");
    expect(expiresAt.getTime() - now).toBe(30 * 24 * 60 * 60 * 1000);
    now = expiresAt.getTime() - 1;
    expect(await auth.userFor(token)).toEqual({ id: 1, username: "alice" });
    now = expiresAt.getTime();
    expect(await auth.userFor(token)).toBeNull();
    expect(store.sessionCount()).toBe(0);
  });

  it("verifies against a dummy hash when the username is unknown", async () => {
    const calls: string[] = [];
    const spy: Hasher = { hash: plain.hash, verify: async (h, p) => { calls.push(h); return plain.verify(h, p); } };
    expect(await new Auth(new MemoryStore(), spy).login("nobody", "password123")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("hashes with argon2id", async () => {
    const h = await argon2.hash("password123");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(h, "password123")).toBe(true);
    expect(await argon2.verify(h, "password124")).toBe(false);
  });
});
