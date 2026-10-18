import { afterEach, describe, expect, it } from "vitest";
import { config, serviceStatus } from "./config.js";

describe("serviceStatus", () => {
  const saved = { ...config };
  afterEach(() => { Object.assign(config, saved); });

  it("reports whether the identification key is set", () => {
    config.agentApiKey = "or-key";
    expect(serviceStatus()).toMatchObject({ agentApiKeyConfigured: true });
    config.agentApiKey = undefined;
    expect(serviceStatus()).toMatchObject({ agentApiKeyConfigured: false });
  });
  it("exposes only flags, never the keys or credentials themselves", () => {
    Object.assign(config, { agentApiKey: "or-secret", username: "user", password: "pass-secret" });
    const status = serviceStatus();
    expect(Object.keys(status).sort()).toEqual(["agentApiKeyConfigured", "credentialsConfigured", "headless", "model"]);
    expect(JSON.stringify(status)).not.toMatch(/secret|"user"/);
  });
});
