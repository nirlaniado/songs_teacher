import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ quiet: true });
export const localDir = resolve(".ug-agent");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(localDir, "browsers");
export const config = {
  // Transcription still runs on OpenAI; song identification uses the agent* settings below.
  apiKey: process.env.OPENAI_API_KEY,
  agentApiKey: process.env.OPENROUTER_API_KEY,
  agentBaseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  model: process.env.UG_AGENT_MODEL || "nvidia/nemotron-3.5-lightning:free",
  // Speech-to-text used to time the slides to the song. Must support verbose_json segment timestamps.
  transcribeModel: process.env.UG_TRANSCRIBE_MODEL || "whisper-1",
  username: process.env.ULTIMATE_GUITAR_USERNAME,
  password: process.env.ULTIMATE_GUITAR_PASSWORD,
  headless: process.env.UG_HEADLESS === "true" || (process.env.UG_HEADLESS !== "false" && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
};
