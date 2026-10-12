import { afterEach, describe, expect, it, vi } from "vitest";
import { isModelCached, loadModelBytes } from "./modelCache.js";

function fakeCaches(stored: Record<string, Response>) {
  const open = vi.fn(async () => ({
    match: async (url: string) => stored[url],
    put: async (url: string, r: Response) => { stored[url] = r; },
  }));
  vi.stubGlobal("caches", { open });
  return open;
}

describe("modelCache", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the existing cache name so already-downloaded models are found", async () => {
    const open = fakeCaches({ "https://m/demucs.onnx": new Response("x") });
    expect(await isModelCached("https://m/demucs.onnx")).toBe(true);
    expect(await isModelCached("https://m/other.onnx")).toBe(false);
    expect(open).toHaveBeenCalledWith("libre-off-models");
  });
  it("serves a cached model without fetching", async () => {
    fakeCaches({ "https://m/a.onnx": new Response(new Uint8Array([1, 2, 3])) });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(new Uint8Array(await loadModelBytes("https://m/a.onnx", () => {}))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("downloads and caches a miss, reporting progress", async () => {
    const stored: Record<string, Response> = {};
    fakeCaches(stored);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([4, 5, 6, 7]), { headers: { "Content-Length": "4" } })));
    const progress = vi.fn();
    expect(new Uint8Array(await loadModelBytes("https://m/b.onnx", progress))).toEqual(new Uint8Array([4, 5, 6, 7]));
    expect(progress).toHaveBeenLastCalledWith(4, 4);
    expect(stored["https://m/b.onnx"]).toBeDefined();
  });
});
