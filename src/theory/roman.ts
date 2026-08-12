import { Chord, Note, Scale } from "tonal";
import type { KeyRef, Mode } from "../schema/song.js";

/**
 * Roman numeral derivation over `tonal`. Best-effort: diatonic chords resolve
 * exactly, chromatic/borrowed chords resolve to the nearest scale degree with
 * an accidental. `section.romanNumerals` exists precisely for the cases this
 * gets wrong (secondary dominants, unusual voicings) — this is a default,
 * not an authority.
 */

const SCALE_NAME: Record<Mode, string> = {
  major: "major",
  minor: "aeolian",
  ionian: "major",
  dorian: "dorian",
  phrygian: "phrygian",
  lydian: "lydian",
  mixolydian: "mixolydian",
  aeolian: "aeolian",
  locrian: "locrian",
  "harmonic-minor": "harmonic minor",
  "melodic-minor": "melodic minor",
};

const DEGREE_BASE = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

/** Chord-type -> numeral suffix. Unlisted types fall back to no suffix rather than garbled text. */
const EXTENSION_SUFFIX: Record<string, string> = {
  major: "",
  minor: "",
  diminished: "",
  augmented: "",
  "dominant seventh": "7",
  "major seventh": "maj7",
  "minor seventh": "7",
  "half-diminished": "7",
  "diminished seventh": "7",
  "dominant ninth": "9",
  "major ninth": "maj9",
  "minor ninth": "9",
  eleventh: "11",
  "dominant eleventh": "11",
  thirteenth: "13",
  "dominant thirteenth": "13",
  sixth: "6",
  "minor sixth": "6",
  "suspended fourth": "sus4",
  "suspended second": "sus2",
};

/** Semitone offsets of each scale degree from the tonic, in degree order. */
export function scaleOffsets(key: KeyRef): number[] {
  const scale = Scale.get(`${key.tonic} ${SCALE_NAME[key.mode]}`);
  const tonicChroma = Note.chroma(key.tonic);
  return scale.notes.map((n) => (Note.chroma(n) - tonicChroma + 12) % 12);
}

function degreeAndAccidental(
  targetOffset: number,
  offsets: readonly number[],
): { degree: number; accidental: "" | "b" | "#" } {
  const exact = offsets.indexOf(targetOffset);
  if (exact !== -1) return { degree: exact, accidental: "" };

  let degree = 0;
  let bestAbsDiff = Infinity;
  let signedDiff = 0;
  for (let i = 0; i < offsets.length; i++) {
    const raw = targetOffset - offsets[i]!;
    const wrapped = ((raw + 6 + 12) % 12) - 6; // shortest signed distance, range [-6, 5]
    const absDiff = Math.abs(wrapped);
    // On a tie (the chromatic tone sits exactly between two scale degrees a
    // whole step apart), convention favors labeling it as a flat of the
    // degree above ("bVII") over a sharp of the degree below ("#VI") —
    // that's how borrowed/Neapolitan chords actually get written.
    const strictlyCloser = absDiff < bestAbsDiff;
    const tiedButFlatter = absDiff === bestAbsDiff && wrapped < 0 && signedDiff > 0;
    if (strictlyCloser || tiedButFlatter) {
      bestAbsDiff = absDiff;
      degree = i;
      signedDiff = wrapped;
    }
  }
  return { degree, accidental: signedDiff > 0 ? "#" : signedDiff < 0 ? "b" : "" };
}

function qualityGlyph(quality: string, type: string): string {
  if (type === "half-diminished") return "ø";
  if (quality === "Diminished") return "°";
  if (quality === "Augmented") return "+";
  return "";
}

function isLowerCase(quality: string): boolean {
  return quality === "Minor" || quality === "Diminished";
}

/** One chord symbol -> a roman numeral in `key`, or undefined if unparseable (e.g. "N.C."). */
export function romanNumeralFor(chordSymbol: string, key: KeyRef): string | undefined {
  const chord = Chord.get(chordSymbol);
  if (chord.empty || !chord.tonic) return undefined;

  const tonicChroma = Note.chroma(key.tonic);
  const rootChroma = Note.chroma(chord.tonic);
  if (Number.isNaN(tonicChroma) || Number.isNaN(rootChroma)) return undefined;

  const offsets = scaleOffsets(key);
  const targetOffset = (rootChroma - tonicChroma + 12) % 12;
  const { degree, accidental } = degreeAndAccidental(targetOffset, offsets);

  const base = DEGREE_BASE[degree]!;
  const cased = isLowerCase(chord.quality) ? base.toLowerCase() : base;
  const glyph = qualityGlyph(chord.quality, chord.type);
  const extension = EXTENSION_SUFFIX[chord.type] ?? "";
  return `${accidental}${cased}${glyph}${extension}`;
}

/** A whole progression, one numeral per chord, in order. Entries are undefined where unparseable. */
export function romanNumeralsFor(
  progression: readonly string[],
  key: KeyRef,
): (string | undefined)[] {
  return progression.map((chord) => romanNumeralFor(chord, key));
}

/**
 * A numeral stripped to its degree + accidental, dropping case and every
 * quality marker: "iiø7" and "ii" and "II7" all reduce to "II". This is what
 * "Quality Variant" edges compare — same skeleton, different chord qualities.
 */
export function skeletonOf(numeral: string): string {
  const match = /^([#b]?)([ivIV]+)/.exec(numeral);
  if (!match) return numeral;
  return `${match[1]}${match[2]!.toUpperCase()}`;
}
