import { compile } from "@fastify/proxy-addr";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { ProxyOptions } from "vite";
import type { TrustProxy } from "./config.js";

/**
 * Vite proxy entry for the accounts API. The API trusts this hop, so this hop decides what
 * the API is told: X-Forwarded-* from a peer that isn't itself a trusted proxy are replaced
 * with what this connection actually shows. A trusted upstream's Proto/Host are kept, not
 * appended to — Fastify reads the last entry, so an appended "http" would hide its HTTPS.
 */
export function apiProxy(trust: TrustProxy, target = "http://127.0.0.1:4319"): ProxyOptions {
  const trusted = trust.length ? compile(trust) : () => false;
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req: IncomingMessage) => {
        const peer = req.socket.remoteAddress ?? "";
        const fromProxy = trusted(peer, 0);
        const upstream = (name: string) => (fromProxy ? req.headers[name] : undefined) as string | undefined;
        const chain = upstream("x-forwarded-for");
        proxyReq.setHeader("x-forwarded-for", chain ? `${chain}, ${peer}` : peer);
        proxyReq.setHeader("x-forwarded-proto", upstream("x-forwarded-proto") ?? ((req.socket as TLSSocket).encrypted ? "https" : "http"));
        const host = upstream("x-forwarded-host") ?? req.headers.host;
        if (host) proxyReq.setHeader("x-forwarded-host", host);
        else proxyReq.removeHeader("x-forwarded-host");
      });
    },
  };
}
