import { createServer } from "node:http";
import { z } from "zod";
import { GuitarAgent } from "./agent.js";
import { AgentError } from "./core.js";
import { serviceStatus } from "./config.js";

const agent = new GuitarAgent();
// Handles requests from the local interface: validates the origin and input, then routes to status checks or agent job creation, continuation, and cancellation.
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Sends an HTTP status code and JSON response to the interface, then ends the request.
  const send = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  try {
    // Loopback binding + Host check prevent DNS rebinding. Custom header + no CORS
    // prevent a third-party page from operating the authenticated local browser.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "") || req.headers["x-ug-agent"] !== "1")
      return send(403, { error: "Access to the local service was refused." });
    if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin))
      return send(403, { error: "The request did not come from a local origin." });
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/api/ug/status")
      return send(200, serviceStatus());
    const match = path.match(/^\/api\/ug\/jobs\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/);
    if (req.method === "GET" && match && !match[2]) {
      const job = agent.get(match[1]!); return send(job ? 200 : 404, job ?? { error: "This request was not found." });
    }
    if (req.method !== "POST") return send(404, { error: "This path was not found." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "The request must be JSON." });
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 8192) return send(413, { error: "The request is too long." });
    }
    let data: unknown;
    try { data = JSON.parse(body); } catch { return send(400, { error: "The request is not valid JSON." }); }
    if (path === "/api/ug/jobs") {
      const input = z.object({ query: z.string().trim().min(3).max(500) }).strict().parse(data);
      return send(202, agent.start(input.query));
    }
    if (match?.[2] === "resume") {
      const input = z.object({ candidateId: z.string().max(100).optional() }).strict().parse(data);
      return send(202, agent.resume(match[1]!, input.candidateId));
    }
    if (match?.[2] === "cancel") { await agent.cancel(match[1]!); return send(200, { ok: true }); }
    send(404, { error: "This path was not found." });
  } catch (error) {
    send(error instanceof z.ZodError ? 400 : error instanceof AgentError ? 409 : 500,
      { error: error instanceof AgentError ? error.message : "The request is not valid, or the service hit an error." });
  }
});
// Starts the service on the loopback address only and prints its address when it is ready to accept requests.
server.listen(4318, "127.0.0.1", () => console.log("Ultimate Guitar agent: http://127.0.0.1:4318"));
// On shutdown, stops accepting connections, closes the browser, and exits the service.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close(); void agent.close().finally(() => process.exit(0));
});
