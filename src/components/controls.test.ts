import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Field, buttonClass, type ButtonVariant, type ControlSize } from "./controls.js";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SIZES: ControlSize[] = ["sm", "md", "lg"];
const VARIANTS: ButtonVariant[] = ["primary", "secondary", "subtle", "destructive", "destructive-subtle"];

const html = (element: ReactElement) => renderToStaticMarkup(element);
const button = (props: Parameters<typeof Button>[0]) => html(createElement(Button, props, "Go"));
const classes = (markup: string) => (/class="([^"]*)"/.exec(markup)?.[1] ?? "").split(" ");

const sourceDir = fileURLToPath(new URL("..", import.meta.url));
const sources = (readdirSync(sourceDir, { recursive: true }) as string[])
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ file, text: readFileSync(join(sourceDir, file), "utf8") }));
const rawButtons = (text: string) => [...text.matchAll(/<button\b[\s\S]*?>/g)].map((m) => m[0]);

const transitions = [...css.matchAll(/transition(?:-property)?:\s*([^;]+);/g)].map((m) => m[1]!);
const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

describe("Button", () => {
  it.each(VARIANTS)("gives variant %s its own class, and only that one", (variant) => {
    const list = classes(button({ variant }));
    expect(list).toContain(`control-${variant}`);
    expect(list.filter((c) => VARIANTS.some((v) => c === `control-${v}`))).toHaveLength(1);
  });

  it.each(SIZES)("gives size %s its own class", (size) => {
    expect(classes(button({ size }))).toContain(`control-${size}`);
  });

  it("defaults to a medium secondary, the commonest button in the app", () => {
    expect(classes(button({}))).toEqual(expect.arrayContaining(["control", "control-secondary", "control-md"]));
  });

  it("defines every variant and size it can emit", () => {
    for (const name of [...VARIANTS, ...SIZES, "icon", "round"]) expect(css).toContain(`.control-${name}`);
    for (const size of SIZES) expect(css).toContain(`.field-${size}`);
  });

  it("keeps a call site's layout classes after its own", () => {
    expect(classes(button({ className: "flex-1" })).at(-1)).toBe("flex-1");
  });

  it("is square for an icon, and round only when asked", () => {
    expect(classes(button({ icon: true }))).toContain("control-icon");
    expect(classes(button({ icon: true }))).not.toContain("control-round");
    expect(classes(button({ icon: "round" }))).toEqual(expect.arrayContaining(["control-icon", "control-round"]));
  });

  it("defaults to type=button, but a form can still ask for submit", () => {
    expect(button({})).toContain('type="button"');
    expect(button({ type: "submit" })).toContain('type="submit"');
  });

  it("announces a toggle's state, and says nothing on a plain button", () => {
    expect(button({ pressed: true })).toContain('aria-pressed="true"');
    expect(button({ pressed: false })).toContain('aria-pressed="false"');
    expect(button({})).not.toContain("aria-pressed");
  });

  it("carries a lit tone for toggles whose on-state means something", () => {
    expect(button({ pressed: true, tone: "danger" })).toContain('data-tone="danger"');
  });

  it("styles a non-button the same way, for a label around a file input", () => {
    expect(buttonClass({ size: "lg" })).toBe("control control-secondary control-lg");
  });
});

describe("Field", () => {
  it("renders one treatment across input, select and textarea", () => {
    const fields = [
      createElement(Field, { size: "sm" }),
      createElement(Field, { as: "select", size: "sm" }),
      createElement(Field, { as: "textarea", size: "sm" }),
    ];
    expect(fields.map((f) => classes(html(f)).sort())).toEqual(Array(3).fill(["field", "field-sm"]));
    expect(html(fields[1]!)).toMatch(/^<select/);
    expect(html(fields[2]!)).toMatch(/^<textarea/);
  });

  it("does not hand its visual size to the input's own size attribute", () => {
    expect(html(createElement(Field, { size: "lg" }))).not.toMatch(/\ssize=/);
  });

  it("marks a bad value for assistive tech as well as by colour", () => {
    expect(html(createElement(Field, { invalid: true }))).toContain('aria-invalid="true"');
    expect(html(createElement(Field, { invalid: false }))).not.toContain("aria-invalid");
  });
});

describe("motion", () => {
  it("transitions only transform and opacity, and always names them", () => {
    expect(transitions.length).toBeGreaterThan(0);
    for (const declaration of transitions) {
      for (const part of declaration.split(",")) expect(part.trim()).toMatch(/^(transform|opacity)\s/);
    }
  });

  it("leaves no transition utility in a component, so index.css is the only place motion is decided", () => {
    for (const { file, text } of sources) {
      const classNames = [...text.matchAll(/className=(?:"[^"]*"|\{[^\n]*)/g)].map((m) => m[0]).join("\n");
      expect(classNames, file).not.toMatch(/\b(transition(-[a-z[\]]+)?|animate-[a-z]+|duration-\d+)(?=[\s"`])/);
    }
  });

  it("takes every duration from a token, so one block can govern them", () => {
    for (const declaration of transitions) expect(declaration).toMatch(/var\(--motion-/);
  });

  it("neutralises every press and travel under reduced motion", () => {
    expect(reducedMotion).toMatch(/--press-scale:\s*1;/);
    expect(reducedMotion).toMatch(/--press-scale-small:\s*1;/);
    expect(reducedMotion).toMatch(/--enter-scale:\s*1;/);
    expect(reducedMotion).toMatch(/--enter-rise:\s*0px;/);
    expect(reducedMotion).toMatch(/--cue-grow-from:\s*1;/);
    expect(reducedMotion).toMatch(/--motion-progress:\s*0ms;/);
  });

  it("moves nothing except through those tokens", () => {
    const literal = [...css.matchAll(/transform:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(literal.length).toBeGreaterThan(0);
    for (const value of literal) expect(value).toMatch(/\(var\(--/);
  });

  it("gates hover behind a real pointer, since touch leaves it stuck", () => {
    const [outside, gated] = css.split("@media (hover: hover) and (pointer: fine)");
    expect(outside).not.toMatch(/:hover/);
    expect(gated).toMatch(/:hover/);
  });
});

describe("focus", () => {
  const rule = /:where\(([^)]*(?:\([^)]*\)[^)]*)*)\):focus-visible \{([^}]*)\}/.exec(css);

  it("covers every kind of interactive element from one rule, using focus-visible", () => {
    for (const element of ["button", "a[href]", "summary", "select", "input", "textarea"]) {
      expect(rule?.[1]).toContain(element);
    }
    expect(rule?.[2]).toMatch(/outline:\s*2px solid/);
  });

  it("does not ring a container focused from code, which would frame the projected slide in Present", () => {
    expect(rule?.[1]).toContain(':not([tabindex="-1"])');
  });

  it("cannot beat an inline style, which is what keeps the inline editor's textarea out of it", () => {
    expect(rule?.[2]).not.toContain("!important");
  });

  it("does not animate the ring", () => {
    expect(rule?.[2]).not.toContain("transition");
  });
});

describe("call sites", () => {
  it("leaves no ad-hoc button styling behind", () => {
    for (const { file, text } of sources) {
      for (const tag of rawButtons(text)) {
        expect(`${file}: ${tag}`).not.toMatch(/\brounded\b(?!-slide)|\bbg-(accent|raised|danger)|\bpx-\d/);
      }
    }
  });

  it("gives every radius a role instead of the default", () => {
    for (const { file, text } of sources) {
      if (file.endsWith("controls.tsx")) continue;
      expect(text, file).not.toMatch(/(?<![\w:-])rounded(-(sm|md|lg|xl))?(?=[\s"`])/);
    }
  });

  it("keeps the form submits explicit, since Button defaults to type=button", () => {
    const submits = (file: string) => sources.find((s) => s.file.endsWith(file))?.text.match(/type="submit"/g)?.length;
    expect(submits("UltimateGuitarAgent.tsx")).toBe(1);
    expect(submits("DeckLibraryScreen.tsx")).toBe(1);
    expect(submits("LibraryScreen.tsx")).toBe(1);
  });
});
