import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { buildApp } from "./app";
import type { Hasher } from "./auth";
import { apiProxy } from "./proxy";
import { MemoryStore } from "./store";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };

// The API behind a real Vite dev-server proxy, configured as vite.config.ts does it. Linux routes
// all of 127.0.0.0/8 to loopback, so clients get distinct addresses: 127.0.0.4 plays a trusted
// TLS terminator in front of Vite, 127.0.0.2/.3 are clients reaching Vite directly.
const TRUSTED = "127.0.0.1, 127.0.0.4";
const TERMINATOR = "127.0.0.4";
describe("accounts API behind the Vite proxy", () => {
  let api: Awaited<ReturnType<typeof buildApp>>;
  let vite: ViteDevServer;
  let port = 0;
  let n = 0;

  beforeAll(async () => {
    api = await buildApp({ store: new MemoryStore(), hasher: plain, trustProxy: TRUSTED, rateLimit: { max: 2, timeWindow: 60_000 } });
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
      const payload = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, path, localAddress: from, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, cookie: String(res.headers["set-cookie"] ?? "") }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  const signup = (headers: Record<string, string>, from = TERMINATOR) =>
    post("/api/auth/signup", { username: `user${++n}`, password: "password123" }, { "x-forwarded-for": `192.0.2.${n}`, ...headers }, from);
  const login = (from: string, headers: Record<string, string> = {}) =>
    post("/api/auth/login", { username: `nobody${++n}`, password: "password123" }, headers, from).then((r) => r.status);

  it("sets Secure when the trusted TLS terminator says the request was HTTPS", async () => {
    const res = await signup({ host: "teacher.example.com", "x-forwarded-proto": "https" });
    expect(res.status).toBe(201);
    expect(res.cookie).toMatch(/Secure/);
  });

  it("leaves Secure off for plain HTTP, whatever the Host", async () => {
    expect((await signup({ host: "teacher.example.com" }, "127.0.0.2")).cookie).not.toMatch(/Secure/);
    expect((await signup({ host: "localhost:5173" }, "127.0.0.2")).cookie).not.toMatch(/Secure/);
  });

  it("gives two clients behind the terminator separate rate limits", async () => {
    const via = (ip: string) => login(TERMINATOR, { "x-forwarded-for": ip });
    expect([await via("203.0.113.1"), await via("203.0.113.1"), await via("203.0.113.1")]).toEqual([401, 401, 429]);
    expect(await via("203.0.113.2")).toBe(401);
  });

  it("gives two clients reaching Vite directly separate rate limits", async () => {
    expect([await login("127.0.0.2"), await login("127.0.0.2"), await login("127.0.0.2")]).toEqual([401, 401, 429]);
    expect(await login("127.0.0.3")).toBe(401);
  });

  it("doesn't let a direct client dodge the limit by forging X-Forwarded-For", async () => {
    const forged = (ip: string) => login("127.0.0.5", { "x-forwarded-for": ip });
    expect([await forged("198.51.100.1"), await forged("198.51.100.2"), await forged("198.51.100.3")]).toEqual([401, 401, 429]);
  });
});
