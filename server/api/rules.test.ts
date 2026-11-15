import { describe, expect, it } from "vitest";
import { Credentials } from "./rules";

const ok = (username: string, password = "long enough!") => Credentials.safeParse({ username, password }).success;

describe("Credentials", () => {
  it("accepts 3–32 letters, digits, _ and -", () => {
    expect(ok("abc")).toBe(true);
    expect(ok("a".repeat(32))).toBe(true);
    expect(ok("Nir_l-10")).toBe(true);
  });
  it("rejects bad usernames", () => {
    for (const u of ["ab", "a".repeat(33), "has space", "dot.name", "émile", "a@b", ""]) expect(ok(u)).toBe(false);
  });
  it("needs a password of at least 10 characters and nothing more", () => {
    expect(ok("user", "123456789")).toBe(false);
    expect(ok("user", "aaaaaaaaaa")).toBe(true);
  });
  it("rejects extra fields", () => {
    expect(Credentials.safeParse({ username: "user", password: "aaaaaaaaaa", admin: true }).success).toBe(false);
  });
});
