import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./config";

describe("parseTrustProxy", () => {
  it("defaults to trusting nobody", () => {
    expect(parseTrustProxy(undefined)).toEqual([]);
    expect(parseTrustProxy("")).toEqual([]);
    expect(parseTrustProxy(" , ")).toEqual([]);
  });

  it("reads explicit addresses, CIDRs and named ranges", () => {
    expect(parseTrustProxy(" loopback, 10.0.0.0/8 ,192.0.2.7, ::1, fd00::/8, uniquelocal ")).toEqual(
      ["loopback", "10.0.0.0/8", "192.0.2.7", "::1", "fd00::/8", "uniquelocal"]);
  });

  it.each(["true", "false", "1", "2", "*", "0.0.0.0/0", "::/0", "loopback, true", "10.0.0.0/33", "proxy.example.com", "localhost"])(
    "rejects %j with a message naming it", (value) => {
      const entry = value.split(",").map((e) => e.trim()).find((e) => e !== "loopback")!;
      expect(() => parseTrustProxy(value)).toThrow(`TRUST_PROXY: "${entry}"`);
    });
});

describe("server startup", () => {
  it("refuses to start with TRUST_PROXY=true", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "server/api/server.ts"], {
      env: { ...process.env, TRUST_PROXY: "true", DATABASE_URL: "" }, encoding: "utf8", timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('TRUST_PROXY: "true"');
    expect(run.stdout).not.toContain("Auth API:");
  }, 30_000);
});
