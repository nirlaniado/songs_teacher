/**
 * Decodes an audio file to mono Float32Arrays, one per entry in `rates`, for
 * analysis (not playback). Uses an OfflineAudioContext so each resample is
 * done by the browser rather than by hand.
 *
 * Several rates come from one decode: the compressed-audio decode is the
 * expensive step, and resampling the decoded buffer again is cheap, so asking
 * for 22.05 kHz (music analysis) and 16 kHz (lyric alignment) together costs
 * one decode rather than two.
 *
 * `decodeAudioData` detaches the ArrayBuffer, so pass a buffer you don't need
 * again.
 */
export async function decodeMono(data: ArrayBuffer, rates: readonly number[]): Promise<Float32Array[]> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }

  const out: Float32Array[] = [];
  for (const rate of rates) {
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, length, rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    // A mono destination downmixes the channels for us.
    source.connect(offline.destination);
    source.start();
    out.push((await offline.startRendering()).getChannelData(0));
  }
  return out;
}
