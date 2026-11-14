import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });

export const PORT = 4319;
export const HOST = "127.0.0.1";

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}

export type TrustProxy = boolean | string;

/** TRUST_PROXY: unset/false, true, or comma-separated addresses/CIDRs (e.g. "loopback"). */
export function parseTrustProxy(value: string | undefined): TrustProxy {
  const v = value?.trim() ?? "";
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  return v;
}

export function trustProxy(): TrustProxy {
  return parseTrustProxy(process.env.TRUST_PROXY);
}
