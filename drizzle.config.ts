import { defineConfig } from "drizzle-kit";
import "./server/api/config.js";

export default defineConfig({
  dialect: "mysql",
  schema: "./server/api/schema.ts",
  out: "./server/api/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
