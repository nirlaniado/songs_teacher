import "./config.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [join(dirname(require.resolve("playwright/package.json")), "cli.js"), "install", "chromium"], { stdio: "inherit", env: process.env });
// Propagates the Chromium installer’s exit code so the installation command reports whether it succeeded.
child.on("exit", code => process.exit(code ?? 1));
// Reports a failure to start the installer and marks the installation as unsuccessful.
child.on("error", () => { console.error("Could not start the browser installer."); process.exitCode = 1; });
