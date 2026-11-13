import { migrate } from "drizzle-orm/mysql2/migrator";
import { databaseUrl } from "./config.js";
import { connect } from "./db.js";

const url = databaseUrl();
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env (see .env.example).");
  process.exit(1);
}
const conn = connect(url);
try {
  await migrate(conn.db, { migrationsFolder: "server/api/migrations" });
  console.log("Migrations applied.");
} finally {
  await conn.pool.end();
}
