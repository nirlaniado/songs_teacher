import { buildApp } from "./app.js";
import { HOST, PORT, adminUsername, databaseUrl, trustProxy } from "./config.js";
import { connect, MySqlStore } from "./db.js";

let trust: string[];
try {
  trust = trustProxy();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const url = databaseUrl();
const conn = url ? connect(url) : null;
if (!conn) console.warn("DATABASE_URL is not set: /api/health will report it and /api/auth answers 503.");
const app = await buildApp({ store: conn && new MySqlStore(conn), logger: { level: "warn" }, trustProxy: trust, adminUsername: adminUsername() });
await app.listen({ port: PORT, host: HOST });
console.log(`Auth API: http://${HOST}:${PORT}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  void app.close().then(() => conn?.pool.end()).finally(() => process.exit(0));
});
