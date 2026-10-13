import { afterEach, describe, expect, it, vi } from "vitest";
import { isModelCached, loadModelBytes } from "./modelCache.js";

/** Like the real Cache API, `put` reads the whole response body before it resolves. */
function fakeCaches(stored: Record<string, Response>) {
  const open = vi.fn(async () => ({
    match: async (url: string) => stored[url]?.clone(),
    put: async (url: string, r: Response) => { stored[url] = new Response(await r.arrayBuffer()); },
  }));
  vi.stubGlobal("caches", { open });
  return open;
}

/** A download whose chunks arrive only when the test releases them; `abort` on the request's signal errors the stream. */
function slowDownload(chunks: Uint8Array[], contentLength?: string | null) {
  const releases: Array<() => void> = [];
  const gates = chunks.map(() => new Promise<void>((resolve) => releases.push(resolve)));
  let signal: AbortSignal | undefined;
  let aborted = false;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("aborted", "AbortError")); });
      },
      async pull(controller) {
        if (i === chunks.length) return controller.close();
        await gates[i];
        if (!aborted) controller.enqueue(chunks[i++]!);
      },
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const length = contentLength === undefined ? String(total) : contentLength;
    return new Response(body, { headers: length === null ? {} : { "Content-Length": length } });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, release: (i: number) => releases[i]!(), signal: () => signal, aborted: () => aborted };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("modelCache", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the existing cache name so already-downloaded models are found", async () => {
    const open = fakeCaches({ "https://m/demucs.onnx": new Response("x") });
    expect(await isModelCached("https://m/demucs.onnx")).toBe(true);
    expect(await isModelCached("https://m/other.onnx")).toBe(false);
    expect(open).toHaveBeenCalledWith("libre-off-models");
  });

  it("serves a model cached by an earlier version without fetching", async () => {
    fakeCaches({ "https://m/a.onnx": new Response(new Uint8Array([1, 2, 3])) });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(new Uint8Array(await loadModelBytes("https://m/a.onnx", () => {}))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports progress as the bytes arrive, and caches only once the whole file is in", async () => {
    const stored: Record<string, Response> = {};
    fakeCaches(stored);
    const download = slowDownload([new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])]);
    const progress = vi.fn();
    const loading = loadModelBytes("https://m/b.onnx", progress);

    download.release(0);
    download.release(1);
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(4, 6));
    expect(stored["https://m/b.onnx"]).toBeUndefined();

    download.release(2);
    expect(new Uint8Array(await loading)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(progress).toHaveBeenLastCalledWith(6, 6);
    expect(new Uint8Array(await stored["https://m/b.onnx"]!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("reports an unknown total as 0 when the response has no Content-Length, and still streams and caches", async () => {
    const stored: Record<string, Response> = {};
    fakeCaches(stored);
    const download = slowDownload([new Uint8Array([1, 2]), new Uint8Array([3, 4])], null);
    const progress = vi.fn();
    const loading = loadModelBytes("https://m/d.onnx", progress);
    download.release(0);
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(2, 0));
    download.release(1);
    expect(new Uint8Array(await loading)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(progress.mock.calls).toEqual([[2, 0], [4, 0]]);
    expect(stored["https://m/d.onnx"]).toBeDefined();
  });

  it("never reports a total below what has arrived when Content-Length understates the body", async () => {
    fakeCaches({});
    const download = slowDownload([new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])], "3");
    const progress = vi.fn();
    const loading = loadModelBytes("https://m/e.onnx", progress);
    for (let i = 0; i < 3; i++) download.release(i);
    expect(new Uint8Array(await loading)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(progress.mock.calls).toEqual([[2, 3], [4, 4], [6, 6]]);
  });

  it("stops a cancelled download and caches nothing", async () => {
    const stored: Record<string, Response> = {};
    fakeCaches(stored);
    const download = slowDownload([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const controller = new AbortController();
    const progress = vi.fn();
    const loading = loadModelBytes("https://m/c.onnx", progress, controller.signal);
    download.release(0);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(2, 4));

    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(download.signal()).toBe(controller.signal);
    expect(download.aborted()).toBe(true);
    await tick();
    expect(stored["https://m/c.onnx"]).toBeUndefined();
  });
});
