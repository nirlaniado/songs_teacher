import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Refuses to produce a production build that carries a real API key.
 *
 * Vite substitutes `VITE_*` variables at build time, so a key in `.env` ends
 * up as a plain string inside `dist/` — readable by anyone who opens the
 * shipped JavaScript. That is perfectly fine while the app only ever runs on
 * your own machine, which is why `.env` stays supported for `npm run dev`.
 *
 * The danger is the one-off `npm run build` whose output later gets served
 * somewhere. A warning would scroll past in the build log unnoticed — exactly
 * the failure this is meant to prevent — so it fails instead, with a
 * deliberate escape hatch for the times you really do want a local production
 * bundle:
 *
 *     ALLOW_BUNDLED_KEY=1 npm run build
 */
function refuseBundledSecrets(): Plugin {
  return {
    name: "libre-off:refuse-bundled-secrets",
    apply: "build",
    config(_config, { mode }) {
      if (process.env.ALLOW_BUNDLED_KEY === "1") return;

      const env = loadEnv(mode, process.cwd(), "VITE_");
      const key = env.VITE_OPENAI_API_KEY?.trim();
      // The untouched template placeholder is not a secret.
      if (!key || key.startsWith("sk-proj-replace-me")) return;

      throw new Error(
        [
          "",
          "  Refusing to build: VITE_OPENAI_API_KEY is set in .env.",
          "",
          "  Vite inlines VITE_* variables into the bundle, so this key would end up",
          "  readable in dist/ by anyone who opens the shipped JavaScript.",
          "",
          "  To publish this build:   remove the key from .env, then build again.",
          "                           Users supply their own key via the assistant's",
          "                           settings, which stays in their own browser.",
          "",
          "  For a local-only build:  ALLOW_BUNDLED_KEY=1 npm run build",
          "",
          "  `npm run dev` is unaffected — it never writes dist/.",
          "",
        ].join("\n"),
      );
    },
  };
}

/**
 * Cross-origin isolation, required by ONNX Runtime's threaded WASM backend
 * (it needs `SharedArrayBuffer`, which browsers gate behind these headers).
 *
 * `credentialless` rather than `require-corp`: the stricter value blocks any
 * cross-origin subresource that doesn't explicitly opt in, which would break
 * loading the Demucs model from Hugging Face. `credentialless` sends such
 * requests without credentials instead of refusing them.
 *
 * These must be reproduced by whatever serves a production build, or stem
 * separation falls back to single-threaded WASM and gets much slower.
 */
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

/**
 * Proxies Genius through the dev server.
 *
 * The browser cannot call `api.genius.com` directly. Sending the required
 * `Authorization` header makes the request non-simple, so the browser
 * preflights with OPTIONS — and Genius answers that with 403, which surfaces
 * as a bare "Failed to fetch". Passing the token as a query parameter avoids
 * the preflight but its error responses carry no CORS headers either.
 *
 * Proxying sidesteps all of it: the page makes a same-origin request, so
 * there is no CORS involved at all. It also means the token is injected
 * server-side and **never enters the browser bundle** — strictly better than
 * the `VITE_`-prefixed variable this replaces.
 */
function geniusProxy(token: string | undefined) {
  return {
    "/api/genius": {
      target: "https://api.genius.com",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/genius/, ""),
      configure: (proxy: { on: (e: string, cb: (req: unknown) => void) => void }) => {
        proxy.on("proxyReq", (proxyReq) => {
          if (!token) return; // no token: Genius 401s, and the client says so
          (proxyReq as { setHeader(n: string, v: string): void }).setHeader(
            "Authorization",
            `Bearer ${token}`,
          );
        });
      },
    },
  };
}

// Vitest reads this file too (`npm test` = `vitest run`). The existing
// schema tests are pure logic with no DOM, so no `test.environment` override
// is needed yet — add `environment: "jsdom"` here if component tests show up.
export default defineConfig(({ mode }) => {
  // Loaded with an empty prefix so un-prefixed variables are visible here.
  // `GENIUS_ACCESS_TOKEN` deliberately has no `VITE_`, which keeps it out of
  // the client bundle — it is only ever read in this config, at dev time.
  const env = loadEnv(mode, process.cwd(), "");
  const geniusToken = env.GENIUS_ACCESS_TOKEN?.trim() || undefined;

  return {
    plugins: [react(), tailwindcss(), refuseBundledSecrets()],
    server: { headers: crossOriginIsolation, proxy: geniusProxy(geniusToken) },
    preview: { headers: crossOriginIsolation, proxy: geniusProxy(geniusToken) },
    // Pre-bundling the ORT WASM bundle breaks its worker/wasm asset resolution.
    optimizeDeps: { exclude: ["onnxruntime-web"] },
  };
});
