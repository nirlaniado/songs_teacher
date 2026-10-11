import OpenAI, { toFile } from "openai";
import { config } from "./config.js";
import { AgentError } from "./core.js";

/**
 * Turns a recording into timestamped phrases so a song's sections can be found
 * by their words. Only the audio goes to OpenAI; the chart's lyrics never
 * leave this machine (matching happens in the browser), and the transcript is
 * used to find timings, then discarded.
 */

export interface Segment { start: number; end: number; text: string }
export interface Transcript { segments: Segment[]; duration: number }

const MAX_SEGMENTS = 1000;

/** Drops anything malformed rather than trusting the API's shape. */
export function cleanSegments(raw: ReadonlyArray<{ start?: unknown; end?: unknown; text?: unknown }>): Segment[] {
  const out: Segment[] = [];
  for (const s of raw) {
    if (typeof s.start !== "number" || typeof s.end !== "number" || typeof s.text !== "string") continue;
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start) continue;
    const text = s.text.trim();
    if (text) out.push({ start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, text });
    if (out.length >= MAX_SEGMENTS) break;
  }
  return out;
}

export type TranscribeCall = (audio: Buffer) => Promise<{ duration?: number; segments?: ReadonlyArray<{ start?: unknown; end?: unknown; text?: unknown }> }>;

function openAiCall(): TranscribeCall {
  if (!config.apiKey) throw new AgentError("configuration", "OPENAI_API_KEY is missing from the local service's environment.");
  const client = new OpenAI({ apiKey: config.apiKey, timeout: 120_000, maxRetries: 1 });
  return async (audio) => {
    try {
      return await client.audio.transcriptions.create({
        file: await toFile(audio, "song.wav", { type: "audio/wav" }),
        model: config.transcribeModel,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new AgentError("model_api", `OpenAI transcription failed (HTTP ${error.status ?? "unknown"}). Check the API key, model access and quota.`);
      }
      throw new AgentError("model_output", "OpenAI transcription failed.");
    }
  };
}

export async function transcribeAudio(audio: Buffer, call: TranscribeCall = openAiCall()): Promise<Transcript> {
  const result = await call(audio);
  const segments = cleanSegments(result.segments ?? []);
  const duration = typeof result.duration === "number" && Number.isFinite(result.duration)
    ? result.duration
    : segments.at(-1)?.end ?? 0;
  return { segments, duration };
}
