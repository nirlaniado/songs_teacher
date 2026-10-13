/**
 * Decodes an audio file to mono Float32Arrays, one per entry in `rates`, for
 * analysis (not playback). Uses an OfflineAudioContext so each resample is
 * done by the browser rather than by hand.
 *
 * Several rates come from one decode: the compressed-audio decode is the
 * expensive step, and resampling the decoded buffer again is cheap, so asking
 * for 22.05 kHz (music analysis) and 16 kHz (lyric alignment) together costs
 * one decode rather than two. A rate that fails to render comes back as its
 * Error rather than failing the rest, so a caller can do without a copy it
 * only wanted for an optional step; a file that can't be decoded at all
 * throws.
 *
 * `decodeAudioData` detaches the ArrayBuffer, so pass a buffer you don't need
 * again.
 */
export async function decodeMono(data: ArrayBuffer, rates: readonly number[]): Promise<Array<Float32Array | Error>> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }

  const out: Array<Float32Array | Error> = [];
  for (const rate of rates) {
    try {
      const length = Math.max(1, Math.ceil(decoded.duration * rate));
      const offline = new OfflineAudioContext(1, length, rate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      // A mono destination downmixes the channels for us.
      source.connect(offline.destination);
      source.start();
      out.push((await offline.startRendering()).getChannelData(0));
    } catch (err) {
      out.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return out;
}
