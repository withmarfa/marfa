/**
 * The preview covers every page the server hands a person, and every one
 * of them actually renders.
 *
 * T-507's premise: anything only visible by reaching a hard-to-reach state
 * gets built once and never looked at again. The invalid-scope failure was
 * first seen by the operator on production rather than by anyone building
 * it, because the page that rendered it had no preview.
 *
 * Two properties, and the second is the one that bites.
 *
 * **Coverage.** A route module that exports a page renderer and is not
 * reachable in the gallery fails here. The list is discovered from the
 * source tree rather than hand-maintained, because a hand-maintained list
 * of "things to remember to preview" is the thing that failed.
 *
 * **Liveness.** Every variant is actually invoked. A fixture whose params
 * drifted from its renderer's signature type-checks perfectly and throws the
 * moment somebody opens it — which, for a preview tool, means it is broken
 * exactly when it is finally needed. Calling them all here is what stops the
 * gallery quietly rotting into a directory of exceptions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TABS } from "../../scripts/auth-gallery-fixtures.js";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Page renderers that are deliberately not in the gallery, each with the
 * reason. Kept short on purpose: an entry here is a page nobody will look
 * at again.
 */
const NOT_PREVIEWED: { symbol: string; because: string }[] = [
  {
    symbol: "renderAuthLayout",
    because:
      "The shell every other page passes through, not a page. It has no " +
      "standalone state to preview.",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.includes(".generated.")
    ) {
      out.push(abs);
    }
  }
  return out;
}

/** Every exported `render*Page`-shaped symbol across the route modules. */
function exportedPageRenderers(): { symbol: string; file: string }[] {
  const found: { symbol: string; file: string }[] = [];
  for (const abs of walk(ROUTES_DIR)) {
    const source = readFileSync(abs, "utf8");
    for (const m of source.matchAll(/^export function (render[A-Z]\w*)/gm)) {
      found.push({
        symbol: m[1] ?? "",
        file: relative(ROUTES_DIR, abs).split(sep).join("/"),
      });
    }
  }
  return found;
}

/** The gallery fixture source, as text — the coverage check reads which
 *  renderers it imports rather than trying to introspect closures. */
const FIXTURES_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../scripts/auth-gallery-fixtures.ts", import.meta.url),
  ),
  "utf8",
);

describe("the preview covers every page the server renders", () => {
  it("finds the renderers at all", () => {
    // A discovery step that silently finds nothing makes the coverage
    // assertion below vacuously true.
    const renderers = exportedPageRenderers();
    expect(renderers.length).toBeGreaterThan(15);
  });

  it("every exported page renderer is reachable in the gallery", () => {
    const missing = exportedPageRenderers()
      .filter((r) => !NOT_PREVIEWED.some((n) => n.symbol === r.symbol))
      .filter((r) => !FIXTURES_SOURCE.includes(r.symbol))
      .map((r) => `${r.file}:${r.symbol}`);

    expect(missing).toEqual([]);
  });

  it("every exemption names a reason", () => {
    for (const entry of NOT_PREVIEWED) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
  });
});

describe("every gallery variant renders", () => {
  const cases = TABS.flatMap((tab) =>
    tab.screens.flatMap((screen) =>
      [...screen.variants, ...(screen.designVariants ?? [])].map((variant) => ({
        id: `${tab.id}/${screen.id}/${variant.id}`,
        variant,
      })),
    ),
  );

  it("has a meaningful number of variants", () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  it.each(cases)("renders $id", ({ variant }) => {
    const html = variant.render();
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
    // Every one is a whole document — the gallery drops each into an iframe,
    // so a fragment renders unstyled and looks like a broken page rather
    // than a broken fixture.
    expect(html.toLowerCase()).toContain("<!doctype html>");
  });
});
