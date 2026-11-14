import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { ProxyOptions } from "vite";

/**
 * Vite proxy entry for the accounts API. Unlike `xfwd`, it keeps an upstream proxy's
 * X-Forwarded-Proto/Host instead of appending its own: Fastify reads the last entry,
 * so behind a TLS terminator an appended "http" would hide that the request was HTTPS.
 * X-Forwarded-For is appended as usual, so the API can find the client by trusting hops.
 */
export function apiProxy(target = "http://127.0.0.1:4319"): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req: IncomingMessage) => {
        const forwardedFor = req.headers["x-forwarded-for"];
        const peer = req.socket.remoteAddress ?? "";
        proxyReq.setHeader("x-forwarded-for", forwardedFor ? `${forwardedFor}, ${peer}` : peer);
        if (!req.headers["x-forwarded-proto"])
          proxyReq.setHeader("x-forwarded-proto", (req.socket as TLSSocket).encrypted ? "https" : "http");
        if (!req.headers["x-forwarded-host"] && req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
      });
    },
  };
}
