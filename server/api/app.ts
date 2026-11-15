import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Auth, type Hasher } from "./auth.js";
import type { TrustProxy } from "./config.js";
import { AccountDeletion, Credentials, PasswordChange } from "./rules.js";
import { UsernameTaken, type AuthStore, type User } from "./store.js";
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
  /** ADMIN_USERNAME: that account can't delete itself. */
  adminUsername?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8192, trustProxy: options.trustProxy?.length ? options.trustProxy : false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const limit = { rateLimit: options.rateLimit ?? { max: 10, timeWindow: 60_000 } };
  const store = options.store;
  const auth = store && new Auth(store, options.hasher, options.now);
  await auth?.init();
  const throttle = new LoginThrottle(options.lockout?.max, options.lockout?.windowMs, options.now);
  const isAdminName = (username: string) => !!options.adminUsername && username.toLowerCase() === options.adminUsername.toLowerCase();
  const isAdmin = (user: User) => isAdminName(user.username);
  const present = (user: User) => (isAdmin(user) ? { ...user, admin: true } : user);

  /**
   * Checks a signed-in user's own password, under the same per-account lockout as login. Sends the refusal and
   * returns true if refused. A boolean, not the reply: a reply is thenable, so an async function can't return it.
   */
  async function refusePassword(user: User, password: string, reply: FastifyReply): Promise<boolean> {
    const wait = throttle.lockedFor(user.username);
    if (wait) {
      reply.code(429).header("Retry-After", Math.ceil(wait / 1000)).send({ error: "Too many failed attempts for this account. Try again later." });
      return true;
    }
    if (await auth!.checkPassword(user.id, password)) {
      throttle.succeed(user.username);
      return false;
    }
    throttle.fail(user.username);
    reply.code(403).send({ error: "Wrong password." });
    return true;
  }
  const badInput = (reply: FastifyReply, issues: { message: string }[]) => reply.code(400).send({ error: issues[0]?.message ?? "Invalid input." });
  const notSignedIn = (reply: FastifyReply) => reply.code(401).send({ error: "Not signed in." });

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
      if (!input.success) return badInput(reply, input.error.issues);
      try {
        // The admin account is never made here (#39): its name answers exactly like a taken one.
        const session = await auth!.signup(input.data.username, input.data.password, isAdminName(input.data.username));
        setSession(req, reply, session.token, session.expiresAt);
        return reply.code(201).send({ user: present(session.user) });
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
      return { user: present(session.user) };
    });

    routes.post("/api/auth/logout", async (req, reply) => {
      await auth!.logout(req.cookies[COOKIE]);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.get("/api/auth/me", async (req, reply) => {
      const user = await auth!.userFor(req.cookies[COOKIE]);
      if (!user) return notSignedIn(reply);
      return { user: present(user) };
    });

    routes.post("/api/auth/password", { config: limit }, async (req, reply) => {
      const session = await auth!.sessionFor(req.cookies[COOKIE]);
      if (!session) return notSignedIn(reply);
      const input = PasswordChange.safeParse(req.body);
      if (!input.success) return badInput(reply, input.error.issues);
      if (await refusePassword(session.user, input.data.currentPassword, reply)) return reply;
      const fresh = await auth!.changePassword(session.user, input.data.newPassword);
      setSession(req, reply, fresh.token, fresh.expiresAt);
      return { ok: true };
    });

    routes.post("/api/auth/logout-all", async (req, reply) => {
      const session = await auth!.sessionFor(req.cookies[COOKIE]);
      if (!session) return notSignedIn(reply);
      await auth!.endAllSessions(session.user.id);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.delete("/api/auth/account", { config: limit }, async (req, reply) => {
      const session = await auth!.sessionFor(req.cookies[COOKIE]);
      if (!session) return notSignedIn(reply);
      const input = AccountDeletion.safeParse(req.body);
      if (!input.success) return badInput(reply, input.error.issues);
      if (isAdmin(session.user)) return reply.code(403).send({ error: "The admin account can't be deleted." });
      if (await refusePassword(session.user, input.data.password, reply)) return reply;
      await auth!.deleteUser(session.user.id);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
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
