import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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

// Vitest reads this file too (`npm test` = `vitest run`). The existing
// schema tests are pure logic with no DOM, so no `test.environment` override
// is needed yet — add `environment: "jsdom"` here if component tests show up.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { headers: crossOriginIsolation, proxy: { "/api/ug": "http://127.0.0.1:4318" } },
  preview: { headers: crossOriginIsolation, proxy: { "/api/ug": "http://127.0.0.1:4318" } },
  // Pre-bundling the ORT WASM bundle breaks its worker/wasm asset resolution.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: { exclude: ["**/node_modules/**", "**/dist*/**"] },
});
