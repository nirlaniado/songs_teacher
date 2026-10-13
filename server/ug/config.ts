import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ quiet: true });
export const localDir = resolve(".ug-agent");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(localDir, "browsers");
export const config = {
  agentApiKey: process.env.OPENROUTER_API_KEY,
  agentBaseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  model: process.env.UG_AGENT_MODEL || "nvidia/nemotron-3.5-lightning:free",
  username: process.env.ULTIMATE_GUITAR_USERNAME,
  password: process.env.ULTIMATE_GUITAR_PASSWORD,
  headless: process.env.UG_HEADLESS === "true" || (process.env.UG_HEADLESS !== "false" && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
};

export function serviceStatus() {
  return {
    model: config.model,
    agentApiKeyConfigured: Boolean(config.agentApiKey),
    credentialsConfigured: Boolean(config.username && config.password),
    headless: config.headless,
  };
}
