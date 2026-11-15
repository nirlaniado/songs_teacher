import { argon2 } from "./auth.js";
import { adminUsername, databaseUrl } from "./config.js";
import { connect, MySqlStore } from "./db.js";
import { makeAdmin } from "./makeAdmin.js";
import { terminalPrompts } from "./terminal.js";

const url = databaseUrl();
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env (see .env.example).");
  process.exit(1);
}
const conn = connect(url);
try {
  process.exitCode = await makeAdmin({ store: new MySqlStore(conn), hasher: argon2, adminUsername: adminUsername(), prompts: terminalPrompts });
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await conn.pool.end();
}
