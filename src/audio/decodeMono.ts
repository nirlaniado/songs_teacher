/**
 * Decodes an audio file to a mono Float32Array at `rate`, for analysis (not
 * playback). Uses an OfflineAudioContext so the resample is done by the
 * browser rather than by hand.
 *
 * `decodeAudioData` detaches the ArrayBuffer, so pass a buffer you don't need
 * again.
 */
export async function decodeMono(data: ArrayBuffer, rate = 22050): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }

  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const offline = new OfflineAudioContext(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  // A mono destination downmixes the channels for us.
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
