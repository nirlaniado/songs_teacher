import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Auth, type Hasher } from "./auth.js";
import type { TrustProxy } from "./config.js";
import { Credentials } from "./rules.js";
import { UsernameTaken, type AuthStore } from "./store.js";
import { LoginThrottle } from "./throttle.js";

export const COOKIE = "session";

export interface AppOptions {
  store: AuthStore | null;
  hasher?: Hasher;
  now?: () => number;
  /** Attempts per client IP per window on signup and login. */
  rateLimit?: { max: number; timeWindow: number };
  /** Failed logins allowed per username per window, from any IP. */
  lockout?: { max: number; windowMs: number };
  /** Which proxies may set X-Forwarded-*; decides the client IP and whether the request was HTTPS. */
  trustProxy?: TrustProxy;
  logger?: boolean | { level: string };
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8192, trustProxy: options.trustProxy ?? false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const limit = { rateLimit: options.rateLimit ?? { max: 10, timeWindow: 60_000 } };
  const store = options.store;
  const auth = store && new Auth(store, options.hasher, options.now);
  await auth?.init();
  const throttle = new LoginThrottle(options.lockout?.max, options.lockout?.windowMs, options.now);

  app.addHook("onSend", async (_req, reply) => { reply.header("Cache-Control", "no-store"); });

  app.get("/api/health", async (_req, reply) => {
    if (!store) return reply.code(503).send({ ok: false, database: "not configured" });
    try {
      await store.ping();
      return { ok: true, database: "reachable" };
    } catch {
      return reply.code(503).send({ ok: false, database: "unreachable" });
    }
  });

  app.register(async (routes) => {
    routes.addHook("onRequest", async (_req, reply) => {
      if (!auth) return reply.code(503).send({ error: "Accounts are unavailable: DATABASE_URL is not set." });
    });

    routes.post("/api/auth/signup", { config: limit }, async (req, reply) => {
      const input = Credentials.safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Invalid input." });
      try {
        const session = await auth!.signup(input.data.username, input.data.password);
        setSession(req, reply, session.token, session.expiresAt);
        return reply.code(201).send({ user: session.user });
      } catch (error) {
        if (error instanceof UsernameTaken) return reply.code(409).send({ error: "That username is taken." });
        throw error;
      }
    });

    routes.post("/api/auth/login", { config: limit }, async (req, reply) => {
      const input = Credentials.safeParse(req.body);
      if (input.success) {
        const wait = throttle.lockedFor(input.data.username);
        if (wait) return reply.code(429).header("Retry-After", Math.ceil(wait / 1000))
          .send({ error: "Too many failed attempts for this account. Try again later." });
      }
      // Malformed credentials get the same answer as wrong ones.
      const session = input.success ? await auth!.login(input.data.username, input.data.password) : null;
      if (!session) {
        if (input.success) throttle.fail(input.data.username);
        return reply.code(401).send({ error: "Wrong username or password." });
      }
      throttle.succeed(input.data!.username);
      setSession(req, reply, session.token, session.expiresAt);
      return { user: session.user };
    });

    routes.post("/api/auth/logout", async (req, reply) => {
      await auth!.logout(req.cookies[COOKIE]);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.get("/api/auth/me", async (req, reply) => {
      const user = await auth!.userFor(req.cookies[COOKIE]);
      if (!user) return reply.code(401).send({ error: "Not signed in." });
      return { user };
    });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error.statusCode;
    if (status && status < 500) return reply.code(status).send({ error: error.message });
    req.log.error(error);
    return reply.code(500).send({ error: "The server hit an error." });
  });

  return app;
}

function cookieOptions(req: FastifyRequest) {
  // `protocol` honours X-Forwarded-Proto only from a trusted proxy (see trustProxy).
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: req.protocol === "https" };
}

function setSession(req: FastifyRequest, reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(COOKIE, token, { ...cookieOptions(req), expires: expiresAt });
}
