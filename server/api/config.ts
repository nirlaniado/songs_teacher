import { compile } from "@fastify/proxy-addr";
import { config as loadEnv } from "dotenv";
import { isIP } from "node:net";
loadEnv({ quiet: true });

export const PORT = 4319;
export const HOST = "127.0.0.1";

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}

/** The proxies allowed to set X-Forwarded-*: an explicit list, empty meaning none. */
export type TrustProxy = string[];

const NAMED = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * TRUST_PROXY: comma-separated IPs, CIDRs or the names loopback/linklocal/uniquelocal.
 * `true`, hop counts and /0 ranges are refused: each trusts hops a client can forge
 * X-Forwarded-For through, which defeats the per-IP limit.
 */
export function parseTrustProxy(value: string | undefined): TrustProxy {
  const entries = (value ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const bad = (why: string) => new Error(`TRUST_PROXY: "${entry}" ${why}. List the proxy addresses, CIDRs or loopback/linklocal/uniquelocal, comma-separated.`);
    if (NAMED.has(entry)) continue;
    const [address = "", prefix] = entry.split("/");
    // isIP is strict where the trust library isn't: it would read "1" as 0.0.0.1, not refuse a hop count.
    if (!isIP(address)) throw bad("is not an IP address, CIDR or known range name");
    if (prefix !== undefined && Number(prefix) === 0) throw bad("trusts every address");
    try { compile(entry); } catch { throw bad("is not a valid CIDR"); }
  }
  return entries;
}

export function trustProxy(): TrustProxy {
  return parseTrustProxy(process.env.TRUST_PROXY);
}
