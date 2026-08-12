import type { DeckPlayer, StemSource } from "./types.js";

/**
 * Synchronised multi-track playback through the Web Audio API.
 *
 * **Why not four `<audio>` elements:** each media element runs its own
 * independent clock, so four of them started "together" drift apart within
 * seconds and there is no way to hold them in lockstep. Every
 * `AudioBufferSourceNode` here is started against a single
 * `AudioContext.currentTime`, which makes them sample-accurate by
 * construction rather than by hope.
 *
 * Two consequences shape everything below:
 *
 * 1. `AudioBufferSourceNode` is **one-shot** — it cannot be paused, resumed or
 *    re-started. Pausing and seeking both mean discarding the nodes and
 *    building new ones at an offset. That bookkeeping lives here so callers
 *    just call `seek()`.
 * 2. There is no `currentTime` to read. The clock is derived from the
 *    context: `ctx.currentTime - startedAt + offset`.
 *
 * Memory: a decoded 4-minute stereo stem is roughly 85 MB, so four is ~340 MB.
 * Acceptable for one song, heavy for a long one — hence `dispose()` dropping
 * the buffers, and the deliberate choice never to decode the full mix
 * alongside the stems.
 */
export async function createStemPlayer(sources: readonly StemSource[]): Promise<DeckPlayer> {
  const ctx = new AudioContext();

  // Decoded in parallel; `decodeAudioData` detaches the ArrayBuffer it is
  // given, so each source is used exactly once.
  const decoded = await Promise.all(
    sources.map(async (source) => ({
      id: source.id,
      buffer: await ctx.decodeAudioData(source.data),
    })),
  );

  const gains = new Map<string, GainNode>();
  for (const { id } of decoded) {
    const node = ctx.createGain();
    node.connect(ctx.destination);
    gains.set(id, node);
  }

  // Longest stem wins: separation output can differ by a few samples, and
  // truncating to the shortest would clip the end of the song.
  const duration = decoded.reduce((max, d) => Math.max(max, d.buffer.duration), 0);

  let nodes: AudioBufferSourceNode[] = [];
  let playing = false;
  /** Context time at which the current run began. */
  let startedAt = 0;
  /** Position within the song that the current run began from. */
  let offset = 0;

  function stopNodes() {
    for (const node of nodes) {
      // The `ended` handler is removed first so tearing down for a seek isn't
      // mistaken for the song finishing.
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already stopped; harmless.
      }
      node.disconnect();
    }
    nodes = [];
  }

  function startNodes(from: number) {
    stopNodes();
    startedAt = ctx.currentTime;
    offset = Math.max(0, Math.min(from, duration));

    for (const { id, buffer } of decoded) {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(gains.get(id)!);
      // All started against one context clock — this is the sync guarantee.
      node.start(0, offset);
      nodes.push(node);
    }

    // One node reaching the end ends the run; they are the same length.
    const last = nodes.at(-1);
    if (last) {
      last.onended = () => {
        if (!playing) return;
        playing = false;
        offset = duration;
        stopNodes();
      };
    }
  }

  function position(): number {
    if (!playing) return offset;
    return Math.min(duration, offset + (ctx.currentTime - startedAt));
  }

  return {
    async ready() {
      // Decoding already finished before this player was handed out.
    },

    async play() {
      if (playing) return;
      // Autoplay policy leaves a fresh context suspended until a gesture.
      if (ctx.state === "suspended") await ctx.resume();
      // Restart from the top if the last run reached the end.
      startNodes(offset >= duration ? 0 : offset);
      playing = true;
    },

    pause() {
      if (!playing) return;
      // Capture the position *before* tearing down, or it is lost.
      offset = position();
      playing = false;
      stopNodes();
    },

    seek(seconds) {
      const target = Math.max(0, Math.min(seconds, duration));
      if (playing) startNodes(target);
      else offset = target;
    },

    currentTime: () => position(),
    duration: () => duration,
    isPlaying: () => playing,

    setGains(next) {
      for (const [id, node] of gains) {
        const value = next[id] ?? 1;
        // A short ramp instead of a jump: setting gain instantly produces an
        // audible click, which is glaring when muting mid-song.
        node.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
      }
    },

    dispose() {
      playing = false;
      stopNodes();
      for (const node of gains.values()) node.disconnect();
      gains.clear();
      // Releases the decoded buffers — hundreds of MB for a four-stem song.
      decoded.length = 0;
      void ctx.close();
    },
  };
}
