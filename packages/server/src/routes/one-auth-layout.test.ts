/**
 * One layout, one stylesheet, for every page the server hands a person.
 *
 * A copy is easy to add and invisible once added: a page with its own
 * stylesheet drifts from the rest without anything failing. So the guard is
 * structural rather than visual: a route module that builds its own document,
 * or carries its own stylesheet, fails the build and has to say why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));
const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Modules allowed to emit a document envelope or a stylesheet, each for a
 * reason that does not generalize.
 */
const ALLOWED: { file: string; because: string }[] = [
  {
    file: "pages/render.ts",
    because:
      "The page system's one place for the doctype: every page built from its " +
      "parts is rendered through it, and its shell writes the rest of the envelope.",
  },
];

/** Every `.ts` and `.tsx` under a directory, tests and generated files excluded. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else if (
      /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      !entry.includes(".generated.")
    ) {
      out.push(abs);
    }
  }
  return out;
}

function relFromSrc(abs: string): string {
  return relative(SRC_DIR, abs).split(sep).join("/");
}

/**
 * Strip comments before scanning.
 *
 * Several page modules carry a doc line stating they emit no inline
 * `<style>` block — which a naive scan reads as evidence of the opposite.
 * The first version of this guard failed on exactly those files, which is
 * a good reminder that a structural check has to look at code and not at
 * prose about the code.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("every server-rendered page uses the one shared layout", () => {
  const files = [...walk(ROUTES_DIR), ...walk(PAGES_DIR)].map((abs) => ({
    rel: relFromSrc(abs),
    source: withoutComments(readFileSync(abs, "utf8")),
  }));

  it("finds the route modules at all", () => {
    // A walker that silently returns nothing would make every assertion
    // below vacuously true, which is the failure mode a structural guard is
    // most prone to.
    expect(files.length).toBeGreaterThan(15);
    expect(files.map((f) => f.rel)).toContain("pages/render.ts");
    expect(files.map((f) => f.rel)).toContain("pages/parts/shell.tsx");
  });

  it("no route module builds its own document envelope", () => {
    const offenders = files
      .filter((f) => /<!doctype html>/i.test(f.source))
      .map((f) => f.rel)
      .filter((rel) => !ALLOWED.some((a) => a.file === rel));

    expect(offenders).toEqual([]);
  });

  it("no route module carries its own stylesheet", () => {
    // Both a `<style>` block and a `const SOMETHING_CSS` — the second is how
    // the two duplicates were actually written, and a check for `<style>`
    // alone would have missed the shape they took.
    const offenders = files
      .filter(
        (f) =>
          f.source.includes("<style>") || /\b[A-Z_]+_CSS\s*=/.test(f.source),
      )
      .map((f) => f.rel)
      .filter((rel) => !ALLOWED.some((a) => a.file === rel));

    expect(offenders).toEqual([]);
  });

  it("every allowance names a reason that does not generalize", () => {
    for (const entry of ALLOWED) {
      expect(entry.because.length).toBeGreaterThan(40);
      expect(files.map((f) => f.rel)).toContain(entry.file);
    }
  });
});
