import { describe, expect, it } from "vitest";
import {
  clearSolos,
  initialStemState,
  isSilent,
  resolveGains,
  setStemGain,
  sortStems,
  toggleStem,
  type StemState,
} from "./mix.js";
import type { StemId } from "../schema/deck.js";

const FOUR: StemId[] = ["drums", "bass", "vocals", "other"];
const fresh = (): StemState[] => FOUR.map(initialStemState);

describe("resolveGains", () => {
  it("passes everything through at full gain by default", () => {
    expect(resolveGains(fresh())).toEqual({ drums: 1, bass: 1, vocals: 1, other: 1 });
  });

  it("silences a muted stem and leaves the rest alone", () => {
    const gains = resolveGains(toggleStem(fresh(), "vocals", "muted"));
    expect(gains.vocals).toBe(0);
    expect(gains.drums).toBe(1);
  });

  it("solo silences everything unsoloed", () => {
    const gains = resolveGains(toggleStem(fresh(), "bass", "soloed"));
    expect(gains).toEqual({ drums: 0, bass: 1, vocals: 0, other: 0 });
  });

  it("multiple solos all sound", () => {
    let stems = toggleStem(fresh(), "bass", "soloed");
    stems = toggleStem(stems, "drums", "soloed");
    const gains = resolveGains(stems);
    expect(gains.bass).toBe(1);
    expect(gains.drums).toBe(1);
    expect(gains.vocals).toBe(0);
  });

  it("solo beats mute on the same stem", () => {
    // Soloing the bass must work even if the bass was muted first, or
    // "solo the bass" fails confusingly.
    let stems = toggleStem(fresh(), "bass", "muted");
    stems = toggleStem(stems, "bass", "soloed");
    expect(resolveGains(stems).bass).toBe(1);
  });

  it("mute is ignored entirely while anything is soloed", () => {
    let stems = toggleStem(fresh(), "bass", "soloed");
    stems = toggleStem(stems, "drums", "muted");
    const gains = resolveGains(stems);
    expect(gains.drums).toBe(0); // silent because unsoloed, not because muted
    expect(gains.bass).toBe(1);
  });

  it("mute applies again once solos are cleared", () => {
    let stems = toggleStem(fresh(), "vocals", "muted");
    stems = toggleStem(stems, "bass", "soloed");
    expect(resolveGains(stems).drums).toBe(0);
    stems = clearSolos(stems);
    const gains = resolveGains(stems);
    expect(gains.drums).toBe(1);
    expect(gains.vocals).toBe(0);
  });

  it("applies per-stem gain to audible stems", () => {
    const gains = resolveGains(setStemGain(fresh(), "drums", 0.4));
    expect(gains.drums).toBeCloseTo(0.4);
  });

  it("gain does not resurrect a silenced stem", () => {
    let stems = setStemGain(fresh(), "vocals", 0.8);
    stems = toggleStem(stems, "vocals", "muted");
    expect(resolveGains(stems).vocals).toBe(0);
  });

  it("handles an empty stem list", () => {
    expect(resolveGains([])).toEqual({});
  });
});

describe("setStemGain", () => {
  it("clamps out-of-range values rather than trusting the caller", () => {
    expect(setStemGain(fresh(), "bass", 5).find((s) => s.id === "bass")!.gain).toBe(1);
    expect(setStemGain(fresh(), "bass", -2).find((s) => s.id === "bass")!.gain).toBe(0);
  });
});

describe("isSilent", () => {
  it("is false for a default mix", () => {
    expect(isSilent(fresh())).toBe(false);
  });

  it("is true once every stem is muted", () => {
    const all = fresh().map((s) => ({ ...s, muted: true }));
    expect(isSilent(all)).toBe(true);
  });

  it("is false when something is soloed", () => {
    expect(isSilent(toggleStem(fresh(), "bass", "soloed"))).toBe(false);
  });

  it("is true when every gain is zeroed", () => {
    const all = fresh().map((s) => ({ ...s, gain: 0 }));
    expect(isSilent(all)).toBe(true);
  });
});

describe("sortStems", () => {
  it("gives a stable display order regardless of file order", () => {
    const shuffled = [{ id: "drums" as const }, { id: "vocals" as const }, { id: "bass" as const }];
    expect(sortStems(shuffled).map((s) => s.id)).toEqual(["vocals", "bass", "drums"]);
  });

  it("does not mutate its input", () => {
    const input = [{ id: "drums" as const }, { id: "vocals" as const }];
    sortStems(input);
    expect(input.map((s) => s.id)).toEqual(["drums", "vocals"]);
  });
});
