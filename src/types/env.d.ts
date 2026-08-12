/**
 * Typed access to the `VITE_*` variables from `.env`.
 *
 * All optional: the app runs perfectly without any of them, falling back to
 * the assistant's ⚙ settings (or to the built-in parser alone). Nothing here
 * is required for the editor itself.
 *
 * Reminder that shapes how these are used: Vite substitutes these at BUILD
 * time, so they end up as literals inside the shipped JavaScript. They are
 * a local-development convenience, not a secret store.
 */
interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_OPENAI_BASE_URL?: string;
  readonly VITE_OPENAI_MODEL?: string;
  /** Override the Demucs ONNX model URL — self-host it, or use a different export. */
  readonly VITE_DEMUCS_MODEL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
