import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { buildApp } from "./app";
import type { Hasher } from "./auth";
import { apiProxy } from "./proxy";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };

// The API behind a real Vite dev-server proxy, configured as vite.config.ts and the documented
// TRUST_PROXY=loopback do it. Linux routes all of 127.0.0.0/8 to loopback, so clients can get
// distinct addresses — and every one of them is inside the API's trusted range, which is the point:
// a client on the same machine as Vite must still not be able to speak for a proxy.
describe("accounts API behind the Vite proxy, TRUST_PROXY=loopback", () => {
  let api: Awaited<ReturnType<typeof buildApp>>;
  let vite: ViteDevServer;
  let port = 0;
  let n = 0;

  beforeAll(async () => {
    api = await buildApp({ store: new MemoryStore(), hasher: plain, trustProxy: ["loopback"], rateLimit: { max: 2, timeWindow: 60_000 } });
    await api.listen({ port: 0, host: "127.0.0.1" });
    const target = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    vite = await createServer({
      configFile: false, logLevel: "silent", appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: "127.0.0.1", port: 0, allowedHosts: true, proxy: { "/api/auth": apiProxy(target) }, hmr: false, watch: null },
    });
    await vite.listen();
    port = (vite.httpServer!.address() as AddressInfo).port;
  });
  afterAll(async () => { await vite?.close(); await api?.close(); });

  const post = (path: string, body: object, headers: Record<string, string>, from: string) =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, localAddress: from, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, cookie: String(res.headers["set-cookie"] ?? "") }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const signup = (from: string, headers: Record<string, string> = {}) =>
    post("/api/auth/signup", { username: `user${++n}`, password: "password123" }, headers, from);
  const login = (from: string, headers: Record<string, string> = {}) =>
    post("/api/auth/login", { username: `nobody${++n}`, password: "password123" }, headers, from).then((r) => r.status);

  it("holds a direct loopback client to its own limit while it rotates forged forwarded headers", async () => {
    // 127.0.0.1 is also the address of the Vite-to-API hop the API must trust.
    const forged = (i: number) => login("127.0.0.1", { "x-forwarded-for": `198.51.100.${i}`, "x-forwarded-proto": "https" });
    expect([await forged(1), await forged(2), await forged(3)]).toEqual([401, 401, 429]);
    expect(await login("127.0.0.2")).toBe(401);
  });

  it("doesn't give a direct loopback client a Secure cookie for a forged X-Forwarded-Proto", async () => {
    for (const from of ["127.0.0.3", "127.0.0.4"]) {
      const res = await signup(from, { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.1", "x-forwarded-host": "teacher.example.com" });
      expect(res.status).toBe(201);
      expect(res.cookie).not.toMatch(/Secure/);
    }
  });

  it("leaves Secure off for plain HTTP, whatever the Host", async () => {
    for (const host of ["teacher.example.com", "localhost:5173"]) {
      const res = await signup("127.0.0.5", { host });
      expect(res.status).toBe(201);
      expect(res.cookie).not.toMatch(/Secure/);
    }
  });

  it("gives two clients reaching Vite separate rate limits", async () => {
    expect([await login("127.0.0.6"), await login("127.0.0.6"), await login("127.0.0.6")]).toEqual([401, 401, 429]);
    expect(await login("127.0.0.7")).toBe(401);
  });
});
