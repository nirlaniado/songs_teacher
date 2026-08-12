import { describe, expect, it } from "vitest";
import { romanNumeralFor, romanNumeralsFor, skeletonOf } from "./roman.js";
import type { KeyRef } from "../schema/song.js";

const C_MAJOR: KeyRef = { tonic: "C", mode: "major" };
const A_MINOR: KeyRef = { tonic: "A", mode: "minor" };
const D_DORIAN: KeyRef = { tonic: "D", mode: "dorian" };
const G_MIXOLYDIAN: KeyRef = { tonic: "G", mode: "mixolydian" };

describe("romanNumeralFor", () => {
  it("derives the diatonic triads of a major key", () => {
    expect(romanNumeralFor("C", C_MAJOR)).toBe("I");
    expect(romanNumeralFor("Dm", C_MAJOR)).toBe("ii");
    expect(romanNumeralFor("Em", C_MAJOR)).toBe("iii");
    expect(romanNumeralFor("F", C_MAJOR)).toBe("IV");
    expect(romanNumeralFor("G", C_MAJOR)).toBe("V");
    expect(romanNumeralFor("Am", C_MAJOR)).toBe("vi");
    expect(romanNumeralFor("Bdim", C_MAJOR)).toBe("vii°");
  });

  it("matches the example song's axis progression exactly", () => {
    // song.example.json: F-C-G-Am in C major reads IV-I-V-vi
    expect(romanNumeralsFor(["F", "C", "G", "Am"], C_MAJOR)).toEqual(["IV", "I", "V", "vi"]);
    // and the intro's Am-F-C-G, explicitly keyed to A minor, reads i-VI-III-VII
    expect(romanNumeralsFor(["Am", "F", "C", "G"], A_MINOR)).toEqual(["i", "VI", "III", "VII"]);
  });

  it("derives diatonic triads of natural minor", () => {
    expect(romanNumeralFor("Am", A_MINOR)).toBe("i");
    expect(romanNumeralFor("Bdim", A_MINOR)).toBe("ii°");
    expect(romanNumeralFor("C", A_MINOR)).toBe("III");
    expect(romanNumeralFor("Dm", A_MINOR)).toBe("iv");
    expect(romanNumeralFor("Em", A_MINOR)).toBe("v");
  });

  it("respects modal degrees that differ from the parallel major", () => {
    // D dorian's natural vi is diminished (B dim), not minor as it would be in D major.
    expect(romanNumeralFor("Bdim", D_DORIAN)).toBe("vi°");
    // G mixolydian's bVII (F major) is diatonic, not a borrowed chord.
    expect(romanNumeralFor("F", G_MIXOLYDIAN)).toBe("VII");
  });

  it("marks chromatic roots with an accidental rather than misreading the degree", () => {
    // Db is not in C major; nearest degree is I (C), a semitone below.
    expect(romanNumeralFor("Db", C_MAJOR)).toBe("bII");
  });

  it("appends extension suffixes without disturbing case or accidental", () => {
    expect(romanNumeralFor("G7", C_MAJOR)).toBe("V7");
    expect(romanNumeralFor("Dm7", C_MAJOR)).toBe("ii7");
    expect(romanNumeralFor("Cmaj7", C_MAJOR)).toBe("Imaj7");
    expect(romanNumeralFor("Bm7b5", C_MAJOR)).toBe("viiø7");
  });

  it("is transposition-invariant: the same relative motion reads the same numerals", () => {
    expect(romanNumeralsFor(["F", "C", "G", "Am"], C_MAJOR)).toEqual(
      romanNumeralsFor(["G", "D", "A", "Bm"], { tonic: "D", mode: "major" }),
    );
  });

  it("returns undefined for symbols tonal cannot parse as a chord", () => {
    expect(romanNumeralFor("N.C.", C_MAJOR)).toBeUndefined();
  });
});

describe("skeletonOf", () => {
  it("strips case and quality markers, keeping degree and accidental", () => {
    expect(skeletonOf("ii")).toBe("II");
    expect(skeletonOf("iiø7")).toBe("II");
    expect(skeletonOf("II7")).toBe("II");
    expect(skeletonOf("vii°")).toBe("VII");
    expect(skeletonOf("bVII")).toBe("bVII");
    expect(skeletonOf("V7")).toBe("V");
  });
});
