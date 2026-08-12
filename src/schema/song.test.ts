import { describe, expect, it } from "vitest";
import example from "../example/song.example.json";
import { Song, effectiveKey, migrateSong, newSong, parseSong, sectionAt, summarize } from "./song.js";

const parsed = Song.parse(example);

/** Clone the fixture and mutate it, so each case starts from something valid. */
function mutate(fn: (draft: any) => void) {
  const draft = structuredClone(example) as any;
  fn(draft);
  return Song.safeParse(draft);
}

describe("Song schema", () => {
  it("accepts the example song", () => {
    expect(parsed.title).toBe("Paper Lanterns");
    expect(parsed.sections).toHaveLength(3);
  });

  it("applies defaults for omitted fields", () => {
    const song = newSong({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Untitled",
      key: { tonic: "G", mode: "mixolydian" },
      audio: { path: "audio.flac" },
    });
    expect(song.timeSignature).toBe("4/4");
    expect(song.tags).toEqual([]);
    expect(song.sections).toEqual([]);
  });

  it("accepts a song with no audio file at all", () => {
    // v3 made `audio` optional so a song whose only source was removed still
    // opens, keeping its sections and analysis.
    const result = mutate((d) => delete d.audio);
    expect(result.success).toBe(true);
  });

  it("rejects a bad tonic", () => {
    expect(mutate((d) => (d.key.tonic = "H")).success).toBe(false);
  });

  it("rejects a section that ends before it starts", () => {
    expect(mutate((d) => (d.sections[0].end = 0)).success).toBe(false);
  });

  it("rejects overlapping sections", () => {
    // Verse 1 starts at 12.4; push the intro past it.
    const result = mutate((d) => (d.sections[0].end = 20));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("must not overlap");
  });

  it("rejects sections that are not sorted by start time", () => {
    const result = mutate((d) => {
      [d.sections[0], d.sections[1]] = [d.sections[1], d.sections[0]];
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("sorted by start time");
  });

  it("rejects duplicate section ids", () => {
    const result = mutate((d) => (d.sections[1].id = d.sections[0].id));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate section id");
  });

  it("rejects a roman numeral override that does not match the progression length", () => {
    const result = mutate((d) => (d.sections[2].romanNumerals = ["IV", "I"]));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown block kind", () => {
    expect(mutate((d) => (d.sections[1].blocks[0].kind = "video")).success).toBe(false);
  });

  it("requires six strings on a guitar chord", () => {
    expect(mutate((d) => d.sections[2].blocks[1].chords[0].frets.pop()).success).toBe(false);
  });
});

describe("migrateSong", () => {
  const v1 = () => ({
    ...structuredClone(example),
    schemaVersion: 1,
    audio: { path: "audio.mp3", duration: 63.0 },
  });

  const v2Youtube = () => {
    const { audio: _drop, ...rest } = structuredClone(example) as Record<string, unknown>;
    return {
      ...rest,
      schemaVersion: 2,
      audio: { kind: "youtube", videoId: "dQw4w9WgXcQ", duration: 212 },
    };
  };

  it("carries a v1 song all the way to the current version", () => {
    // The steps chain rather than returning early — a v1 file on disk must not
    // stop one version short of current.
    const song = parseSong(v1());
    expect(song.schemaVersion).toBe(3);
    expect(song.audio).toEqual({ path: "audio.mp3", duration: 63.0 });
  });

  it("drops the v2 `kind` discriminant from a file song", () => {
    const migrated = migrateSong({ ...v1(), schemaVersion: 2, audio: { kind: "file", path: "a.mp3" } }) as {
      schemaVersion: number;
      audio: unknown;
    };
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.audio).toEqual({ path: "a.mp3" });
  });

  it("removes the audio of a YouTube song but preserves the video id in notes", () => {
    // Losing the reference entirely would leave no record of what the song
    // was, and re-finding it by hand is tedious.
    const song = parseSong(v2Youtube());
    expect(song.schemaVersion).toBe(3);
    expect(song.audio).toBeUndefined();
    expect(song.notes).toContain("dQw4w9WgXcQ");
  });

  it("keeps existing notes when appending the removed-source note", () => {
    const song = parseSong({ ...v2Youtube(), notes: "Original analysis." });
    expect(song.notes).toContain("Original analysis.");
    expect(song.notes).toContain("dQw4w9WgXcQ");
  });

  it("leaves an already-current song untouched", () => {
    expect(migrateSong(example)).toEqual(example);
  });
});

describe("effectiveKey", () => {
  it("prefers the section key when the section reinterprets the mode", () => {
    expect(effectiveKey(parsed, parsed.sections[0]!)).toEqual({ tonic: "A", mode: "minor" });
  });

  it("falls back to the song key", () => {
    expect(effectiveKey(parsed, parsed.sections[1]!)).toEqual({ tonic: "C", mode: "major" });
  });
});

describe("sectionAt", () => {
  const sections = parsed.sections;

  it("finds the section containing the time", () => {
    expect(sectionAt(sections, 0)?.name).toBe("Intro");
    expect(sectionAt(sections, 20)?.name).toBe("Verse 1");
    expect(sectionAt(sections, 62.9)?.name).toBe("Chorus");
  });

  it("treats a boundary as belonging to the later section", () => {
    expect(sectionAt(sections, 12.4)?.name).toBe("Verse 1");
    expect(sectionAt(sections, 38.2)?.name).toBe("Chorus");
  });

  it("returns null past the end and before the start", () => {
    expect(sectionAt(sections, 63)).toBeNull();
    expect(sectionAt(sections, 999)).toBeNull();
    expect(sectionAt([{ ...sections[0]!, start: 5 }], 1)).toBeNull();
  });

  it("returns null inside a gap between sections", () => {
    const gapped = [sections[0]!, { ...sections[2]!, start: 50, end: 60 }];
    expect(sectionAt(gapped, 30)).toBeNull();
  });

  it("handles an empty song", () => {
    expect(sectionAt([], 0)).toBeNull();
  });
});

describe("summarize", () => {
  it("keeps only listing fields", () => {
    expect(summarize(parsed)).toEqual({
      id: parsed.id,
      title: "Paper Lanterns",
      artist: "Demo Artist",
      tags: ["axis-progression", "pop", "study/rotation"],
      updatedAt: parsed.updatedAt,
      hasAudio: true,
    });
  });
});
