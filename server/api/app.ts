import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Auth, type Hasher, type Session } from "./auth.js";
import type { TrustProxy } from "./config.js";
import { AccountDeletion, AuditQuery, Credentials, PasswordChange, UserId, UserListQuery } from "./rules.js";
import { UsernameTaken, type AuthStore, type User, type UserRecord } from "./store.js";
import { LoginThrottle } from "./throttle.js";

export const COOKIE = "session";

declare module "fastify" {
  interface FastifyRequest { session: Session | null }
}

/** What a must-change-password session may still do: see the flag, change the password, leave. */
const UNRESTRICTED = new Set([
  "GET /api/auth/me", "POST /api/auth/password", "POST /api/auth/logout", "POST /api/auth/logout-all",
  "POST /api/auth/login", "POST /api/auth/signup",
]);

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
  /** ADMIN_USERNAME: the one admin account. */
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
  const present = (user: User, mustChangePassword = false) => ({
    ...user, ...(isAdmin(user) && { admin: true }), ...(mustChangePassword && { mustChangePassword: true }),
  });

  /**
   * Checks a signed-in user's own password, under the same per-account lockout as login. Returns the hash it was
   * verified against, which the write that follows must still find; or sends the refusal and returns null. Not the
   * reply: a reply is thenable, so an async function can't return it.
   */
  async function verifiedHash(user: User, password: string, reply: FastifyReply): Promise<string | null> {
    const wait = throttle.lockedFor(user.username);
    if (wait) {
      reply.code(429).header("Retry-After", Math.ceil(wait / 1000)).send({ error: "Too many failed attempts for this account. Try again later." });
      return null;
    }
    const hash = await auth!.checkPassword(user.id, password);
    if (hash) {
      throttle.succeed(user.username);
      return hash;
    }
    throttle.fail(user.username);
    reply.code(403).send({ error: "Wrong password." });
    return null;
  }
  const badInput = (reply: FastifyReply, issues: { message: string }[]) => reply.code(400).send({ error: issues[0]?.message ?? "Invalid input." });
  const notSignedIn = (reply: FastifyReply) => reply.code(401).send({ error: "Not signed in." });

  /** The user an admin route names, or null once a 400/404/403 has been sent. The admin account is never a target. */
  async function targetOf(req: FastifyRequest, reply: FastifyReply): Promise<UserRecord | null> {
    const params = UserId.safeParse(req.params);
    if (!params.success) {
      badInput(reply, params.error.issues);
      return null;
    }
    const user = await store!.findUserById(params.data.id);
    if (!user) reply.code(404).send({ error: "No such user." });
    else if (isAdmin(user)) reply.code(403).send({ error: "The admin account can't be changed here." });
    else return user;
    return null;
  }

  app.decorateRequest("session", null);

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

    // Every account and admin route passes here: the session is read once, and the two gates live in this one place.
    routes.addHook("onRequest", async (req, reply) => {
      req.session = await auth!.sessionFor(req.cookies[COOKIE]);
      const route = `${req.method} ${req.routeOptions.url}`;
      if (req.session?.mustChangePassword && !UNRESTRICTED.has(route))
        return reply.code(403).send({ error: "Change your password before doing anything else.", code: "must_change_password" });
      if (req.routeOptions.url?.startsWith("/api/admin/")) {
        if (!req.session) return notSignedIn(reply);
        if (!isAdmin(req.session.user)) return reply.code(403).send({ error: "Only the admin can do that." });
      }
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
      const result = input.success ? await auth!.login(input.data.username, input.data.password) : null;
      if (result?.kind !== "ok") {
        if (result?.kind === "disabled") return reply.code(403).send({ error: "This account is disabled.", code: "account_disabled" });
        if (input.success) throttle.fail(input.data.username);
        return reply.code(401).send({ error: "Wrong username or password." });
      }
      throttle.succeed(input.data!.username);
      setSession(req, reply, result.token, result.expiresAt);
      return { user: present(result.user, result.mustChangePassword) };
    });

    routes.post("/api/auth/logout", async (req, reply) => {
      await auth!.logout(req.cookies[COOKIE]);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.get("/api/auth/me", async (req, reply) => {
      if (!req.session) return notSignedIn(reply);
      return { user: present(req.session.user, req.session.mustChangePassword) };
    });

    routes.post("/api/auth/password", { config: limit }, async (req, reply) => {
      const session = req.session;
      if (!session) return notSignedIn(reply);
      const input = PasswordChange.safeParse(req.body);
      if (!input.success) return badInput(reply, input.error.issues);
      const verified = await verifiedHash(session.user, input.data.currentPassword, reply);
      if (!verified) return reply;
      const fresh = await auth!.changePassword(session, verified, input.data.newPassword);
      // An admin disable, reset or delete landed after the check: this session is over and nothing was changed.
      if (!fresh) return notSignedIn(reply);
      setSession(req, reply, fresh.token, fresh.expiresAt);
      return { ok: true };
    });

    routes.post("/api/auth/logout-all", async (req, reply) => {
      const session = req.session;
      if (!session) return notSignedIn(reply);
      if (!(await auth!.endAllSessions(session))) return notSignedIn(reply);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.delete("/api/auth/account", { config: limit }, async (req, reply) => {
      const session = req.session;
      if (!session) return notSignedIn(reply);
      const input = AccountDeletion.safeParse(req.body);
      if (!input.success) return badInput(reply, input.error.issues);
      if (isAdmin(session.user)) return reply.code(403).send({ error: "The admin account can't be deleted." });
      const verified = await verifiedHash(session.user, input.data.password, reply);
      if (!verified) return reply;
      if (!(await auth!.deleteOwnAccount(session, verified))) return notSignedIn(reply);
      reply.clearCookie(COOKIE, cookieOptions(req));
      return { ok: true };
    });

    routes.get("/api/admin/users", async (req, reply) => {
      const query = UserListQuery.safeParse(req.query);
      if (!query.success) return badInput(reply, query.error.issues);
      const { page, perPage, search } = query.data;
      const { items, total } = await store!.listUsers({ search, limit: perPage, offset: (page - 1) * perPage });
      return { users: items.map((u) => ({ ...u, admin: isAdmin(u) })), total, page, perPage };
    });

    for (const action of ["disable", "enable"] as const)
      routes.post(`/api/admin/users/:id/${action}`, async (req, reply) => {
        const target = await targetOf(req, reply);
        if (!target) return reply;
        if (!(await auth!.adminChange(target.id, { action }))) return reply.code(404).send({ error: "No such user." });
        return { ok: true };
      });

    routes.post("/api/admin/users/:id/reset-password", async (req, reply) => {
      const target = await targetOf(req, reply);
      if (!target) return reply;
      const reset = await auth!.resetPassword(target.id);
      if (!reset) return reply.code(404).send({ error: "No such user." });
      return { temporaryPassword: reset.temporaryPassword };
    });

    routes.delete("/api/admin/users/:id", async (req, reply) => {
      const target = await targetOf(req, reply);
      if (!target) return reply;
      if (!(await auth!.adminChange(target.id, { action: "delete" }))) return reply.code(404).send({ error: "No such user." });
      return { ok: true };
    });

    routes.get("/api/admin/audit", async (req, reply) => {
      const query = AuditQuery.safeParse(req.query);
      if (!query.success) return badInput(reply, query.error.issues);
      const { page, perPage } = query.data;
      const { items, total } = await store!.listAudit({ limit: perPage, offset: (page - 1) * perPage });
      return { entries: items, total, page, perPage };
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
