import { vi } from "vitest";

// A stand-in for the accounts API in component tests: fetch is stubbed, and each `METHOD /path` answers from
// `routes` the way server/api/app.ts does (status, JSON body, Retry-After). "down" rejects, like a stopped server.
// A route keyed without a query string also answers that path with any query; it gets the URL to read it.
export type Reply = Response | "down";
export type Route = (body: unknown, url: URL) => Reply | Promise<Reply>;
export type Sent = { method: string; path: string; body: unknown };

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Installs the stub; undo with vi.unstubAllGlobals(). */
export function stubAuthServer() {
  const routes: Record<string, Route> = {};
  const requests: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: input, body });
    const url = new URL(input, "http://app.test");
    const route = routes[`${method} ${input}`] ?? routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`unexpected request ${method} ${input}`);
    const reply = await route(body, url);
    if (reply === "down") throw new TypeError("Failed to fetch");
    return reply;
  });
  return { routes, requests };
}
