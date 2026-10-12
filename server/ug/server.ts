import { createServer } from "node:http";
import { z } from "zod";
import { GuitarAgent } from "./agent.js";
import { AgentError } from "./core.js";
import { transcribeAudio } from "./transcribe.js";
import { config, serviceStatus } from "./config.js";

const agent = new GuitarAgent();
// OpenAI's transcription endpoint rejects files over 25 MB.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
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
      return send(403, { error: "גישה לשירות המקומי נדחתה." });
    if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin))
      return send(403, { error: "מקור הבקשה אינו מקומי." });
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/api/ug/status")
      return send(200, serviceStatus());
    const match = path.match(/^\/api\/ug\/jobs\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/);
    if (req.method === "GET" && match && !match[2]) {
      const job = agent.get(match[1]!); return send(job ? 200 : 404, job ?? { error: "הבקשה לא נמצאה." });
    }
    if (req.method !== "POST") return send(404, { error: "הנתיב לא נמצא." });
    // Audio upload for timing: a raw WAV body in, timestamped phrases out.
    if (path === "/api/ug/transcribe") {
      if (!config.apiKey) return send(503, { error: "OPENAI_API_KEY is missing from the local service's environment." });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_AUDIO_BYTES) return send(413, { error: "The audio is too large to send (limit 24 MB)." });
        chunks.push(chunk as Buffer);
      }
      return send(200, await transcribeAudio(Buffer.concat(chunks)));
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "נדרש JSON." });
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 8192) return send(413, { error: "הבקשה ארוכה מדי." });
    }
    let data: unknown;
    try { data = JSON.parse(body); } catch { return send(400, { error: "JSON לא תקין." }); }
    if (path === "/api/ug/jobs") {
      const input = z.object({ query: z.string().trim().min(3).max(500) }).strict().parse(data);
      return send(202, agent.start(input.query));
    }
    if (match?.[2] === "resume") {
      const input = z.object({ candidateId: z.string().max(100).optional() }).strict().parse(data);
      return send(202, agent.resume(match[1]!, input.candidateId));
    }
    if (match?.[2] === "cancel") { await agent.cancel(match[1]!); return send(200, { ok: true }); }
    send(404, { error: "הנתיב לא נמצא." });
  } catch (error) {
    send(error instanceof z.ZodError ? 400 : error instanceof AgentError ? 409 : 500,
      { error: error instanceof AgentError ? error.message : "הבקשה אינה תקינה או שהשירות נתקל בשגיאה." });
  }
});
// Long enough for a local audio upload; the service is loopback-only.
server.requestTimeout = 120_000;
// Starts the service on the loopback address only and prints its address when it is ready to accept requests.
server.listen(4318, "127.0.0.1", () => console.log("Ultimate Guitar agent: http://127.0.0.1:4318"));
// On shutdown, stops accepting connections, closes the browser, and exits the service.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close(); void agent.close().finally(() => process.exit(0));
});
