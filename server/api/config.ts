import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });

export const PORT = 4319;
export const HOST = "127.0.0.1";

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}
