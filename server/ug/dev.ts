import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--import", "tsx", "server/ug/server.ts"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
let stopping = false;
// Stops the interface server and agent service together and sets the exit code. An internal flag prevents duplicate shutdown.
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
// If either development process exits or fails, shuts down both so the other process is not left running alone.
for (const child of children) { child.on("exit", code => stop(code ?? 0)); child.on("error", () => stop(1)); }
// Handles a keyboard interrupt by shutting down both development processes.
process.on("SIGINT", () => stop(0));
// Handles an operating-system termination request by shutting down both development processes.
process.on("SIGTERM", () => stop(0));
