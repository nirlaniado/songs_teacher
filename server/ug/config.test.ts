import { afterEach, describe, expect, it } from "vitest";
import { config, serviceStatus } from "./config.js";

describe("serviceStatus", () => {
  const saved = { ...config };
  afterEach(() => { Object.assign(config, saved); });

  it("reports identification and transcription keys independently", () => {
    config.agentApiKey = "or-key"; config.apiKey = undefined;
    expect(serviceStatus()).toMatchObject({ agentApiKeyConfigured: true, transcribeApiKeyConfigured: false });
    config.agentApiKey = undefined; config.apiKey = "openai-key";
    expect(serviceStatus()).toMatchObject({ agentApiKeyConfigured: false, transcribeApiKeyConfigured: true });
  });
  it("exposes only flags, never the keys or credentials themselves", () => {
    Object.assign(config, { agentApiKey: "or-secret", apiKey: "openai-secret", username: "user", password: "pass-secret" });
    const status = serviceStatus();
    expect(Object.keys(status).sort()).toEqual(["agentApiKeyConfigured", "credentialsConfigured", "headless", "model", "transcribeApiKeyConfigured"]);
    expect(JSON.stringify(status)).not.toMatch(/secret|"user"/);
  });
});
