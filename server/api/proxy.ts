import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { ProxyOptions } from "vite";

/**
 * Vite proxy entry for the accounts API. Vite is a development server, and whoever connects
 * to it is a client, never a proxy: incoming X-Forwarded-* are always discarded and replaced
 * with what this connection shows. The API trusts this hop (TRUST_PROXY=loopback), so relaying
 * a caller's headers would let it forge its IP past the rate limit and the cookie's Secure flag.
 */
export function apiProxy(target = "http://127.0.0.1:4319"): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req: IncomingMessage) => {
        proxyReq.setHeader("x-forwarded-for", req.socket.remoteAddress ?? "");
        proxyReq.setHeader("x-forwarded-proto", (req.socket as TLSSocket).encrypted ? "https" : "http");
        if (req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
        else proxyReq.removeHeader("x-forwarded-host");
      });
    },
  };
}
