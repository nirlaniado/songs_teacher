import { describe, expect, it } from "vitest";
import {
  Deck,
  DECK_SCHEMA_VERSION,
  Slide,
  SlideElement,
  TabElement,
  TextElement,
  buildCues,
  formatCue,
  migrateDeck,
  newDeck,
  parseCue,
  parseDeck,
  slideIndexAt,
  summarizeDeck,
  type LayoutId,
} from "./deck.js";
import { applyLayout, layoutById, LAYOUTS } from "../deck/templates.js";
import { imagePathsOf } from "../components/deck/SlideRenderer.js";

const uuid = () => crypto.randomUUID();

/**
 * `Record<string, unknown>`, not `Partial<Slide>`: the argument is parse
 * *input*, where defaulted fields like `fit` and `dim` are legitimately
 * absent. Typing it as the parsed output would demand those defaults be
 * spelled out in every fixture.
 */
function slide(over: Record<string, unknown> = {}) {
  return Slide.parse({ id: uuid(), ...over });
}

function deck(slides: unknown[] = []) {
  const now = new Date().toISOString();
  return Deck.parse({
    schemaVersion: DECK_SCHEMA_VERSION,
    id: uuid(),
    title: "Test deck",
    slides,
    createdAt: now,
    updatedAt: now,
  });
}

describe("Deck schema", () => {
  it("fills theme defaults rather than storing a bare object", () => {
    const d = newDeck({ id: uuid(), title: "T" });
    // Regression guard: `.default({})` would leave this as `{}` and every
    // renderer would read undefined colors.
    expect(d.theme.background).toEqual({ kind: "color", color: "#ffffff" });
    expect(d.theme.fontFamily).toContain("Inter");
  });

  it("fills nested text style defaults", () => {
    const el = TextElement.parse({ id: uuid(), kind: "text", x: 0, y: 0, w: 100, h: 50 });
    expect(el.style.fontSize).toBe(32);
    expect(el.style.align).toBe("left");
    expect(el.style.lineHeight).toBeCloseTo(1.25);
  });

  it("leaves optional color/font unset so the theme shows through", () => {
    const el = TextElement.parse({ id: uuid(), kind: "text", x: 0, y: 0, w: 10, h: 10 });
    expect(el.style.color).toBeUndefined();
    expect(el.style.fontFamily).toBeUndefined();
  });

  it("fills tab-style defaults, forcing no font choice", () => {
    const el = TabElement.parse({ id: uuid(), kind: "tab", x: 0, y: 0, w: 400, h: 160 });
    expect(el.style.fontSize).toBe(20);
    expect(el.style.lineHeight).toBeCloseTo(1.3);
    expect(el.style.valign).toBe("top");
    // Not a field at all — see the comment on TabStyle: rendering forces a
    // monospace stack because the format needs it, not because it's a look.
    expect("fontFamily" in el.style).toBe(false);
    expect("bold" in el.style).toBe(false);
  });

  it("stores tab text verbatim, with no chord/key parsing", () => {
    const raw = "e|--0---2---3---|\nB|--1---3---0---|";
    const el = TabElement.parse({ id: uuid(), kind: "tab", x: 0, y: 0, w: 400, h: 160, text: raw });
    expect(el.text).toBe(raw);
  });

  it("accepts a tab element as a slide element via the discriminated union", () => {
    const parsed = SlideElement.parse({
      id: uuid(),
      kind: "tab",
      x: 0,
      y: 0,
      w: 400,
      h: 160,
      text: "x32010",
    });
    expect(parsed.kind).toBe("tab");
  });

  it("rejects a non-hex color", () => {
    const result = Deck.safeParse({
      schemaVersion: DECK_SCHEMA_VERSION,
      id: uuid(),
      title: "T",
      theme: { background: { kind: "color", color: "rebeccapurple" } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("hex color");
  });

  it("rejects duplicate slide ids", () => {
    const id = uuid();
    const result = Deck.safeParse({
      schemaVersion: DECK_SCHEMA_VERSION,
      id: uuid(),
      title: "T",
      slides: [
        { id, name: "A", startTime: 0 },
        { id, name: "B", startTime: 10 },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate slide id");
  });

  it("accepts cue times that run forward", () => {
    expect(() =>
      deck([slide({ startTime: 0 }), slide({ startTime: 80 }), slide({ startTime: 142 })]),
    ).not.toThrow();
  });

  it("still loads a deck with two slides on the same cue time", () => {
    // Existing decks contain these; the timing panel warns instead of the schema rejecting them.
    const d = deck([slide({ startTime: 0 }), slide({ startTime: 0 }), slide({ startTime: 20 })]);
    expect(d.slides.map((s) => s.startTime)).toEqual([0, 0, 20]);
  });

  it("rejects cue times that run backwards through the deck", () => {
    // Slide 3 cued before slide 2 would make auto-advance jump backwards.
    expect(() => deck([slide({ startTime: 0 }), slide({ startTime: 90 }), slide({ startTime: 40 })])).toThrow(
      /must run forward/,
    );
  });

  it("allows uncued slides interleaved with cued ones", () => {
    expect(() =>
      deck([slide({ startTime: 0 }), slide(), slide({ startTime: 90 }), slide()]),
    ).not.toThrow();
  });

  it("summarizes without loading slide content", () => {
    const d = deck([slide(), slide({ startTime: 5 })]);
    expect(summarizeDeck(d)).toMatchObject({ title: "Test deck", slideCount: 2, hasAudio: false });
  });
});

describe("backgrounds", () => {
  it("defaults the theme backdrop to a white color, not a bare string", () => {
    const d = newDeck({ id: uuid(), title: "T" });
    expect(d.theme.background).toEqual({ kind: "color", color: "#ffffff" });
  });

  it("accepts an image backdrop and fills its fit/dim defaults", () => {
    const d = deck([slide({ background: { kind: "image", src: "assets/bg.jpg" } })]);
    expect(d.slides[0]!.background).toEqual({
      kind: "image",
      src: "assets/bg.jpg",
      fit: "cover",
      dim: 0,
    });
  });

  it("rejects a dim outside 0..1", () => {
    expect(() =>
      deck([slide({ background: { kind: "image", src: "a.jpg", dim: 1.5 } })]),
    ).toThrow();
  });

  it("rejects an image backdrop with no src", () => {
    expect(() => deck([slide({ background: { kind: "image", src: "" } })])).toThrow();
  });

  it("leaves slide background undefined so it inherits the theme", () => {
    const d = deck([slide()]);
    expect(d.slides[0]!.background).toBeUndefined();
  });
});

describe("stems", () => {
  function deckWithAudio(audio: Record<string, unknown>) {
    const now = new Date().toISOString();
    return Deck.safeParse({
      schemaVersion: DECK_SCHEMA_VERSION,
      id: uuid(),
      title: "T",
      audio,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("accepts a four-stem split alongside the full mix", () => {
    const result = deckWithAudio({
      path: "audio.mp3",
      stems: [
        { id: "drums", path: "stems/drums.wav" },
        { id: "bass", path: "stems/bass.wav" },
        { id: "vocals", path: "stems/vocals.wav" },
        { id: "other", path: "stems/other.wav" },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.audio?.stems).toHaveLength(4);
    // The mix is never replaced — a deck still plays if stems are deleted.
    expect(result.data.audio?.path).toBe("audio.mp3");
  });

  it("accepts the 6-stem ids so adding that model later isn't a schema change", () => {
    const result = deckWithAudio({
      path: "audio.mp3",
      stems: [
        { id: "guitar", path: "stems/guitar.wav" },
        { id: "piano", path: "stems/piano.wav" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown stem id", () => {
    const result = deckWithAudio({
      path: "audio.mp3",
      stems: [{ id: "kazoo", path: "stems/kazoo.wav" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty stems array rather than storing a meaningless one", () => {
    expect(deckWithAudio({ path: "audio.mp3", stems: [] }).success).toBe(false);
  });

  it("leaves stems undefined on a deck that was never separated", () => {
    const result = deckWithAudio({ path: "audio.mp3" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.audio?.stems).toBeUndefined();
  });

  it("a v2 deck with no stems still validates — additive field, no migration", () => {
    // The claim that no version bump was needed, asserted rather than assumed.
    const now = new Date().toISOString();
    const v2 = {
      schemaVersion: 2,
      id: uuid(),
      title: "Old deck",
      audio: { path: "audio.mp3", duration: 100 },
      theme: { background: { kind: "color", color: "#ffffff" } },
      slides: [],
      createdAt: now,
      updatedAt: now,
    };
    const song = parseDeck(v2);
    expect(song.audio?.path).toBe("audio.mp3");
    expect(song.audio?.stems).toBeUndefined();
  });
});

describe("migrateDeck v1 -> v2", () => {
  function v1(over: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: uuid(),
      title: "Old deck",
      theme: {
        background: "#0f172a",
        text: "#f1f5f9",
        accent: "#38bdf8",
        fontFamily: "Inter",
        preset: "dark",
      },
      slides: [
        { id: uuid(), name: "A", background: "#ff0000" },
        { id: uuid(), name: "B" },
      ],
      createdAt: now,
      updatedAt: now,
      ...over,
    };
  }

  it("wraps the theme's flat hex background as a color backdrop", () => {
    const out = migrateDeck(v1()) as { schemaVersion: number; theme: { background: unknown } };
    expect(out.schemaVersion).toBe(2);
    expect(out.theme.background).toEqual({ kind: "color", color: "#0f172a" });
  });

  it("wraps a slide's flat hex background and leaves an absent one absent", () => {
    const out = migrateDeck(v1()) as { slides: Array<Record<string, unknown>> };
    expect(out.slides[0]!.background).toEqual({ kind: "color", color: "#ff0000" });
    expect(out.slides[1]!.background).toBeUndefined();
  });

  it("lets parseDeck load a v1 deck end to end", () => {
    const d = parseDeck(v1());
    expect(d.schemaVersion).toBe(2);
    expect(d.theme.background).toEqual({ kind: "color", color: "#0f172a" });
    expect(d.slides[0]!.background).toEqual({ kind: "color", color: "#ff0000" });
  });

  it("leaves an already-current deck untouched", () => {
    const current = deck([slide()]);
    expect(migrateDeck(current)).toEqual(current);
  });
});

describe("imagePathsOf", () => {
  it("collects element images, slide backgrounds, and the theme backdrop", () => {
    const d = deck([
      slide({ background: { kind: "image", src: "assets/slide-bg.jpg" } }),
      slide({
        elements: [
          {
            id: uuid(),
            kind: "image",
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            src: "assets/photo.png",
          },
        ],
      }),
    ]);
    const withThemeImage = {
      ...d.theme,
      background: { kind: "image" as const, src: "assets/master.jpg", fit: "cover" as const, dim: 0 },
    };
    const paths = imagePathsOf(d.slides, withThemeImage);
    expect(new Set(paths)).toEqual(
      new Set(["assets/master.jpg", "assets/slide-bg.jpg", "assets/photo.png"]),
    );
  });

  it("returns nothing for a deck of plain color slides", () => {
    expect(imagePathsOf(deck([slide(), slide()]).slides)).toEqual([]);
  });

  it("dedupes a path reused across slides", () => {
    const bg = { kind: "image" as const, src: "assets/same.jpg" };
    const d = deck([slide({ background: bg }), slide({ background: bg })]);
    expect(imagePathsOf(d.slides)).toEqual(["assets/same.jpg"]);
  });
});

describe("cue lookup", () => {
  const cues = buildCues([
    slide({ startTime: 0 }),
    slide(), // uncued — skipped by the clock, still reachable manually
    slide({ startTime: 80 }),
    slide({ startTime: 142 }),
  ]);

  it("collects only cued slides, in time order, keeping their deck index", () => {
    expect(cues).toEqual([
      { index: 0, time: 0 },
      { index: 2, time: 80 },
      { index: 3, time: 142 },
    ]);
  });

  it("returns null before the first cue", () => {
    expect(slideIndexAt(cues, -1)).toBeNull();
  });

  it("holds a slide until the next cue is reached", () => {
    expect(slideIndexAt(cues, 0)).toBe(0);
    expect(slideIndexAt(cues, 79.9)).toBe(0);
    expect(slideIndexAt(cues, 80)).toBe(2);
    expect(slideIndexAt(cues, 141.9)).toBe(2);
  });

  it("stays on the last cue past the end of the song", () => {
    expect(slideIndexAt(cues, 9999)).toBe(3);
  });

  it("handles a deck with no cues at all", () => {
    expect(slideIndexAt([], 42)).toBeNull();
  });
});

describe("cue formatting", () => {
  it("round-trips mm:ss", () => {
    expect(formatCue(83)).toBe("1:23");
    expect(parseCue("1:23")).toBe(83);
    expect(parseCue(formatCue(142))).toBe(142);
  });

  it("pads seconds", () => {
    expect(formatCue(65)).toBe("1:05");
    expect(formatCue(0)).toBe("0:00");
  });

  it("accepts bare seconds and fractional input", () => {
    expect(parseCue("90")).toBe(90);
    expect(parseCue("1:23.5")).toBeCloseTo(83.5);
  });

  it("rejects nonsense rather than silently cueing at 0", () => {
    expect(parseCue("")).toBeNull();
    expect(parseCue("abc")).toBeNull();
    expect(parseCue("1:2:3")).toBeNull();
    expect(parseCue("-5")).toBeNull();
  });
});

describe("layouts", () => {
  it("every layout id in the schema has a definition", () => {
    const ids: LayoutId[] = ["blank", "title", "titleContent", "titleTwoContent", "centered", "contentOnly"];
    for (const id of ids) expect(layoutById(id).id).toBe(id);
    expect(LAYOUTS).toHaveLength(ids.length);
  });

  it("generates placeholders that validate as real elements", () => {
    const elements = applyLayout([], "titleContent", uuid);
    expect(elements).toHaveLength(2);
    for (const el of elements) expect(() => TextElement.parse(el)).not.toThrow();
  });

  it("keeps placeholders inside the slide bounds", () => {
    for (const layout of LAYOUTS) {
      for (const el of applyLayout([], layout.id, uuid)) {
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(1280);
        expect(el.y + el.h).toBeLessThanOrEqual(720);
      }
    }
  });

  it("carries text across a layout change instead of discarding it", () => {
    const before = applyLayout([], "titleContent", uuid).map((el) =>
      el.kind === "text" && el.role === "title" ? { ...el, text: "Chorus" } : el,
    );
    const after = applyLayout(before, "titleTwoContent", uuid);
    const title = after.find((el) => el.kind === "text" && el.role === "title");
    expect(title).toBeDefined();
    expect(title!.kind === "text" && title!.text).toBe("Chorus");
  });

  it("preserves user-inserted elements when the layout changes", () => {
    const freeform = {
      id: uuid(),
      kind: "image" as const,
      x: 10,
      y: 10,
      w: 100,
      h: 100,
      rotation: 0,
      locked: false,
      src: "assets/pic.png",
      fit: "contain" as const,
    };
    const after = applyLayout([freeform], "title", uuid);
    expect(after.some((el) => el.kind === "image" && el.src === "assets/pic.png")).toBe(true);
  });

  it("drops placeholders a narrower layout no longer has", () => {
    const two = applyLayout([], "titleTwoContent", uuid);
    expect(two.filter((el) => el.kind === "text" && el.role === "body")).toHaveLength(2);
    const one = applyLayout(two, "title", uuid);
    expect(one.filter((el) => el.kind === "text" && el.role === "body")).toHaveLength(0);
  });
});
