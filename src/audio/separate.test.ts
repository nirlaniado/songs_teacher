import { describe, expect, it } from "vitest";
import { encodeWav } from "./separate.js";

/** Reads the header fields we care about back out of an encoded blob. */
async function header(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataBytes: view.getUint32(40, true),
    totalSize: view.getUint32(4, true),
    view,
  };
}

describe("encodeWav", () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -0.5, 0.5, -1]);

  it("writes a valid 16-bit stereo PCM header", async () => {
    const h = await header(encodeWav(left, right, 44100));
    expect(h.riff).toBe("RIFF");
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.data).toBe("data");
    expect(h.format).toBe(1);
    expect(h.channels).toBe(2);
    expect(h.sampleRate).toBe(44100);
    expect(h.bitsPerSample).toBe(16);
    expect(h.blockAlign).toBe(4);
    expect(h.byteRate).toBe(44100 * 4);
  });

  it("reports sizes consistent with the payload", async () => {
    const h = await header(encodeWav(left, right, 44100));
    expect(h.dataBytes).toBe(left.length * 4); // 4 frames × 2ch × 2 bytes
    expect(h.totalSize).toBe(36 + h.dataBytes);
  });

  it("preserves the deck's own sample rate", async () => {
    const h = await header(encodeWav(left, right, 48000));
    expect(h.sampleRate).toBe(48000);
    expect(h.byteRate).toBe(48000 * 4);
  });

  it("interleaves left and right samples", async () => {
    const h = await header(encodeWav(left, right, 44100));
    // Frame 1 is left=0.5, right=-0.5 — opposite signs prove the ordering.
    expect(h.view.getInt16(44 + 4, true)).toBeGreaterThan(0);
    expect(h.view.getInt16(44 + 6, true)).toBeLessThan(0);
  });

  it("clamps out-of-range samples instead of letting them wrap", async () => {
    // Separation output can overshoot ±1; wrapping would turn a loud passage
    // into harsh noise rather than merely clipping it.
    const hot = new Float32Array([2, -2]);
    const h = await header(encodeWav(hot, hot, 44100));
    expect(h.view.getInt16(44, true)).toBe(32767);
    expect(h.view.getInt16(48, true)).toBe(-32768);
  });

  it("truncates to the shorter channel rather than reading past the end", async () => {
    const h = await header(encodeWav(new Float32Array(10), new Float32Array(4), 44100));
    expect(h.dataBytes).toBe(4 * 4);
  });

  it("handles empty input without producing a malformed file", async () => {
    const h = await header(encodeWav(new Float32Array(0), new Float32Array(0), 44100));
    expect(h.dataBytes).toBe(0);
    expect(h.riff).toBe("RIFF");
  });
});
