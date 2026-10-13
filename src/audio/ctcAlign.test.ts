import { describe, expect, it } from "vitest";
import { VOCAB, forcedAlign, normalizeForVocab, spansToWords } from "./ctcAlign.js";

const BLANK = 0;
const id = (token: string) => VOCAB.indexOf(token as (typeof VOCAB)[number]);
const ids = (tokens: string[]) => tokens.map(id);

/** One frame of log-probabilities where `token` has probability `p` and the rest share the remainder. */
function frame(token: string, p = 0.9): number[] {
  const row = new Array<number>(VOCAB.length).fill(Math.log((1 - p) / (VOCAB.length - 1)));
  row[id(token)] = Math.log(p);
  return row;
}
/** Emissions from a compact string: `_` is blank, any other char is that token. */
const emissions = (pattern: string, p?: number) => [...pattern].map(c => frame(c === "_" ? "<pad>" : c, p));
const frames = (spans: { startFrame: number; endFrame: number }[]) => spans.map(s => [s.startFrame, s.endFrame]);

describe("normalizeForVocab", () => {
  it("uppercases, collapses whitespace runs into one delimiter and keeps apostrophes", () => {
    expect(normalizeForVocab("  don't\n\tstop  me ")).toEqual([..."DON'T", "|", ..."STOP", "|", ..."ME"]);
  });
  it("drops characters with no token, including punctuation-only words", () => {
    expect(normalizeForVocab("Hey, you! — (yeah)")).toEqual([..."HEY", "|", ..."YOU", "|", ..."YEAH"]);
  });
  it("maps typographic apostrophes and strips accents", () => {
    expect(normalizeForVocab("I’m café")).toEqual([..."I'M", "|", ..."CAFE"]);
  });
  it("spells out standalone integers up to 99 and drops every other digit", () => {
    expect(normalizeForVocab("7 days 24 hours")).toEqual([..."SEVEN", "|", ..."DAYS", "|", ..."TWENTY", "|", ..."FOUR", "|", ..."HOURS"]);
    expect(normalizeForVocab("1999 2nd")).toEqual([..."ND"]);
  });
  it("never emits a token outside the vocabulary or a special token", () => {
    const tokens = normalizeForVocab("Ünïcode 123 ½ émojis 🎸 <unk> x2");
    for (const t of tokens) expect(VOCAB.indexOf(t as (typeof VOCAB)[number])).toBeGreaterThan(3);
  });
  it("returns no tokens for empty or unrepresentable text", () => {
    expect(normalizeForVocab("")).toEqual([]);
    expect(normalizeForVocab("  ?! 🎸 ")).toEqual([]);
  });
});

describe("forcedAlign", () => {
  it("aligns a clean single word to the frames it was built with", () => {
    const spans = forcedAlign(emissions("CCAATT"), ids([..."CAT"]), BLANK);
    expect(spans.map(s => s.tokenIndex)).toEqual([0, 1, 2]);
    expect(frames(spans)).toEqual([[0, 2], [2, 4], [4, 6]]);
    for (const s of spans) expect(s.score).toBeCloseTo(0.9);
  });

  it("separates the two Ls in HELLO with a blank even when no blank is emitted between them", () => {
    // The model reports L for four straight frames; a trellis that lets L advance directly to L would split them 2+2 with no gap.
    const spans = forcedAlign(emissions("HELLLLO"), ids([..."HELLO"]), BLANK);
    const [l1, l2] = [spans[2]!, spans[3]!];
    expect(l1.endFrame).toBeLessThan(l2.startFrame);
    expect(spans).toHaveLength(5);
  });

  it("gives the two Ls the frames on either side of an emitted blank", () => {
    const spans = forcedAlign(emissions("HELL_LO"), ids([..."HELLO"]), BLANK);
    expect(frames(spans)).toEqual([[0, 1], [1, 2], [2, 4], [5, 6], [6, 7]]);
  });

  it("needs one extra frame per repeated pair, and throws without it", () => {
    expect(() => forcedAlign(emissions("HELLO"), ids([..."HELLO"]), BLANK)).toThrow(/at least 6 frames/);
    expect(frames(forcedAlign(emissions("HEL_LO"), ids([..."HELLO"]), BLANK))).toEqual([[0, 1], [1, 2], [2, 3], [4, 5], [5, 6]]);
  });

  it("throws when there are fewer frames than tokens", () => {
    expect(() => forcedAlign(emissions("CA"), ids([..."CAT"]), BLANK)).toThrow();
    expect(() => forcedAlign([], ids([..."A"]), BLANK)).toThrow();
  });

  it("throws rather than return a path when every alignment has zero probability", () => {
    const rows = emissions("CAT");
    rows[1]![id("A")] = -Infinity;
    expect(() => forcedAlign(rows, ids([..."CAT"]), BLANK)).toThrow(/non-zero probability/);
  });

  it("returns no spans for an empty target, whatever the frames", () => {
    expect(forcedAlign(emissions("___"), [], BLANK)).toEqual([]);
    expect(forcedAlign([], [], BLANK)).toEqual([]);
  });

  it("rejects the blank token inside the target", () => {
    expect(() => forcedAlign(emissions("A_A"), [id("A"), BLANK, id("A")], BLANK)).toThrow();
  });

  it("keeps leading and trailing silence out of the first and last token", () => {
    const spans = forcedAlign(emissions("__________HI__________"), ids([..."HI"]), BLANK);
    expect(frames(spans)).toEqual([[10, 11], [11, 12]]);
  });

  it("produces monotonic, non-overlapping spans covering every token in order", () => {
    const tokens = normalizeForVocab("let it be");
    const spans = forcedAlign(emissions("__LL_EE_TT|_I_TT_||BB__E_____"), ids(tokens), BLANK);
    expect(spans.map(s => s.tokenIndex)).toEqual(tokens.map((_, i) => i));
    for (const s of spans) expect(s.endFrame).toBeGreaterThan(s.startFrame);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.startFrame).toBeGreaterThanOrEqual(spans[i - 1]!.endFrame);
  });

  it("accepts raw logits as well as log-probabilities", () => {
    const logits = emissions("CCAATT").map(row => row.map(v => v + 5));
    expect(frames(forcedAlign(logits, ids([..."CAT"]), BLANK))).toEqual([[0, 2], [2, 4], [4, 6]]);
  });

  it("stays finite across thousands of frames where linear probabilities would underflow", () => {
    // 0.5^5000 is far below the smallest double; only log space keeps the path score meaningful.
    const pattern = "_".repeat(2500) + "AB" + "_".repeat(2500);
    const spans = forcedAlign(emissions(pattern, 0.5), ids([..."AB"]), BLANK);
    expect(frames(spans)).toEqual([[2500, 2501], [2501, 2502]]);
    for (const s of spans) { expect(Number.isFinite(s.score)).toBe(true); expect(s.score).toBeCloseTo(0.5); }
  });

  it("is deterministic", () => {
    const rows = emissions("_HH_EEL_LLOO_");
    const tokens = ids([..."HELLO"]);
    expect(forcedAlign(rows, tokens, BLANK)).toEqual(forcedAlign(rows, tokens, BLANK));
  });
});

describe("spansToWords", () => {
  it("groups character spans into words on the delimiter", () => {
    const tokens = normalizeForVocab("hi you");
    const words = spansToWords(forcedAlign(emissions("_HI__|_YYOU_"), ids(tokens), BLANK), tokens);
    expect(words).toEqual([
      { text: "HI", startFrame: 1, endFrame: 3 },
      { text: "YOU", startFrame: 7, endFrame: 11 },
    ]);
  });
  it("returns no words for no spans", () => {
    expect(spansToWords([], [])).toEqual([]);
  });
  it("rejects spans that do not belong to the tokens", () => {
    expect(() => spansToWords([], ["A"])).toThrow();
  });
});
