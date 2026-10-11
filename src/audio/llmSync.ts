import { decodeMono } from "./decodeMono.js";
import type { Phrase } from "./lyricSync.js";

/** Speech recognition needs little bandwidth; 16 kHz mono keeps a song well under the upload limit. */
const UPLOAD_RATE = 16000;

/** Mono 16-bit PCM WAV. */
export function encodeMonoWav(samples: Float32Array, rate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Sends the recording to the local agent service, which has it transcribed by
 * OpenAI (the API key stays on the service, never in the browser), and returns
 * the timestamped phrases. Only the audio is sent — never the chart or lyrics.
 *
 * Throws when the service is unreachable or fails, so the caller can fall back
 * to the local analysis.
 */
export async function transcribeMix(mix: Blob, signal?: AbortSignal): Promise<Phrase[]> {
  const wav = encodeMonoWav(await decodeMono(await mix.arrayBuffer(), UPLOAD_RATE), UPLOAD_RATE);
  let response: Response;
  try {
    response = await fetch("/api/ug/transcribe", {
      method: "POST",
      headers: { "X-UG-Agent": "1", "Content-Type": "audio/wav" },
      body: wav,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // A browser network failure only says "Failed to fetch"; the usual cause is a
    // stale tab or a stopped dev server, and reloading the page fixes the first.
    throw new Error("the local agent service isn't reachable — reload this page from the address `npm run dev:agent` prints, and make sure it is still running");
  }
  const data = (await response.json().catch(() => ({}))) as { segments?: Phrase[]; error?: string };
  if (!response.ok || !Array.isArray(data.segments)) throw new Error(data.error ?? "The transcription service failed.");
  return data.segments;
}
