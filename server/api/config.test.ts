import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./config";

describe("parseTrustProxy", () => {
  it("defaults to trusting nobody", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });
  it("reads true and address lists", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy(" loopback, 10.0.0.0/8 ")).toBe("loopback, 10.0.0.0/8");
  });
});
