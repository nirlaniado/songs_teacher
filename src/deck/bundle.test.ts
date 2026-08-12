import { describe, expect, it } from "vitest";
import { Deck, DECK_SCHEMA_VERSION } from "../schema/deck.js";
import type { LibraryAdapter } from "../adapters/index.js";
import { bundleFilename, exportDeckBundle, readDeckBundle } from "./bundle.js";

const uuid = () => crypto.randomUUID();

/** Only the deck-asset reads matter here; everything else is unreachable. */
function fakeAdapter(assets: Record<string, string>): LibraryAdapter {
  return {
    async readDeckAsset(_deckId: string, relPath: string) {
      const content = assets[relPath];
      if (content === undefined) throw new Error(`no such asset: ${relPath}`);
      return new Blob([content]);
    },
  } as unknown as LibraryAdapter;
}

/**
 * `Record<string, unknown>`, not `Partial<Deck>`: the argument is parse
 * *input*, where defaulted fields like `layout` are legitimately absent.
 */
function deckWith(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return Deck.parse({
    schemaVersion: DECK_SCHEMA_VERSION,
    id: uuid(),
    title: "My Song Deck",
    audio: { path: "audio.mp3", duration: 200 },
    slides: [
      { id: uuid(), name: "Intro", startTime: 0 },
      { id: uuid(), name: "Chorus", startTime: 142 },
    ],
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe("exportDeckBundle / readDeckBundle", () => {
  it("round-trips a deck's content unchanged", async () => {
    const deck = deckWith();
    const blob = await exportDeckBundle(fakeAdapter({ "audio.mp3": "AUDIO" }), deck);
    const { deck: back } = await readDeckBundle(blob);

    expect(back.title).toBe(deck.title);
    expect(back.slides.map((s) => s.name)).toEqual(["Intro", "Chorus"]);
    // Cues are the whole point of a song presentation; losing them would
    // quietly ruin the deck.
    expect(back.slides.map((s) => s.startTime)).toEqual([0, 142]);
  });

  it("gives the imported deck a new id so it can't overwrite the original", async () => {
    const deck = deckWith();
    const blob = await exportDeckBundle(fakeAdapter({ "audio.mp3": "AUDIO" }), deck);
    const { deck: back } = await readDeckBundle(blob);
    expect(back.id).not.toBe(deck.id);
  });

  it("carries the audio and image assets", async () => {
    const deck = deckWith({
      slides: [
        {
          id: uuid(),
          name: "Cover",
          elements: [
            {
              id: uuid(),
              kind: "image",
              x: 0,
              y: 0,
              w: 100,
              h: 100,
              rotation: 0,
              locked: false,
              src: "assets/cover.jpg",
              fit: "contain",
            },
          ],
        },
      ],
    });
    const blob = await exportDeckBundle(
      fakeAdapter({ "audio.mp3": "AUDIO", "assets/cover.jpg": "IMAGE" }),
      deck,
    );
    const { assets } = await readDeckBundle(blob);
    expect(new TextDecoder().decode(assets["audio.mp3"])).toBe("AUDIO");
    expect(new TextDecoder().decode(assets["assets/cover.jpg"])).toBe("IMAGE");
  });

  it("excludes stems by default and strips their references", async () => {
    // A bundle that named stems it didn't contain would import a deck
    // pointing at missing audio.
    const deck = deckWith({
      audio: {
        path: "audio.mp3",
        stems: [
          { id: "drums", path: "stems/drums.wav" },
          { id: "bass", path: "stems/bass.wav" },
        ],
      },
    });
    const adapter = fakeAdapter({
      "audio.mp3": "AUDIO",
      "stems/drums.wav": "DRUMS",
      "stems/bass.wav": "BASS",
    });

    const { deck: back, assets } = await readDeckBundle(await exportDeckBundle(adapter, deck));
    expect(back.audio?.stems).toBeUndefined();
    expect(assets["stems/drums.wav"]).toBeUndefined();
    expect(assets["audio.mp3"]).toBeDefined();
  });

  it("includes stems and keeps their references when asked", async () => {
    const deck = deckWith({
      audio: { path: "audio.mp3", stems: [{ id: "drums", path: "stems/drums.wav" }] },
    });
    const adapter = fakeAdapter({ "audio.mp3": "AUDIO", "stems/drums.wav": "DRUMS" });

    const blob = await exportDeckBundle(adapter, deck, { includeStems: true });
    const { deck: back, assets } = await readDeckBundle(blob);
    expect(back.audio?.stems).toHaveLength(1);
    expect(new TextDecoder().decode(assets["stems/drums.wav"])).toBe("DRUMS");
  });

  it("exports even when an asset is missing rather than failing entirely", async () => {
    // Losing one image should not cost the whole presentation.
    const deck = deckWith();
    const blob = await exportDeckBundle(fakeAdapter({}), deck);
    const { deck: back } = await readDeckBundle(blob);
    expect(back.title).toBe("My Song Deck");
  });

  it("rejects a zip that isn't a presentation", async () => {
    const notADeck = await exportDeckBundle(fakeAdapter({}), deckWith());
    const bytes = new Uint8Array(await notADeck.arrayBuffer());
    // Corrupt it so it isn't a readable zip at all.
    await expect(readDeckBundle(new Blob([bytes.slice(0, 20)]))).rejects.toThrow();
  });
});

describe("bundleFilename", () => {
  it("derives a safe name from the title", () => {
    expect(bundleFilename(deckWith({ title: "My Song Deck" }))).toBe("My-Song-Deck.libreoff.zip");
  });

  it("strips characters a filesystem would reject", () => {
    expect(bundleFilename(deckWith({ title: 'A/B:C*"?' }))).toBe("ABC.libreoff.zip");
  });

  it("falls back when the title has nothing usable", () => {
    expect(bundleFilename(deckWith({ title: "///" }))).toBe("presentation.libreoff.zip");
  });
});
