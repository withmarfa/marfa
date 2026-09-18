/**
 * One layout, one stylesheet, for every page the server hands a person.
 *
 * Before this guard there were four styling systems. `renderAuthLayout` and
 * `auth.css` covered thirteen surfaces. `CALLBACK_CSS` and `CONFIGURE_CSS`
 * were hand-written copies of the same design system, each carrying its own
 * comment admitting it was kept in sync by hand — and each had already
 * drifted, one of them all the way back to light-only while the shared
 * stylesheet had followed the device into dark mode for months. Two more
 * pages emitted bare HTML with four rules of inline CSS.
 *
 * Both duplicates justified themselves the same way: these pages render
 * outside `/auth/*` and so have no session. That was never true. The
 * stylesheet is served from a public route that needs no session at all,
 * which is why the consolidation was possible without changing a single
 * access rule.
 *
 * **A copy is easy to add and invisible once added.** Nothing failed when
 * those two drifted; the pages simply looked slightly wrong, on the rare
 * paths where anybody saw them. So the guard is structural rather than
 * visual: a route module that builds its own document, or carries its own
 * stylesheet, fails the build and has to say why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Modules allowed to emit a document envelope or a stylesheet, each for a
 * reason that does not generalize.
 */
const ALLOWED: { file: string; because: string }[] = [
  {
    file: "routes/auth-layout.ts",
    because:
      "The shell itself. This is the one place the doctype, the viewport tag " +
      "and the stylesheet link are written.",
  },
  {
    file: "routes/auth-static/auth-css.ts",
    because:
      "The stylesheet, served as a static asset from a public route. It is " +
      "CSS in a template literal, not a page.",
  },
];

/** Every `.ts` under a directory, tests and generated files excluded. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
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
  const files = walk(ROUTES_DIR).map((abs) => ({
    rel: relFromSrc(abs),
    source: withoutComments(readFileSync(abs, "utf8")),
  }));

  it("finds the route modules at all", () => {
    // A walker that silently returns nothing would make every assertion
    // below vacuously true, which is the failure mode a structural guard is
    // most prone to.
    expect(files.length).toBeGreaterThan(15);
    expect(files.map((f) => f.rel)).toContain("routes/auth-layout.ts");
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
