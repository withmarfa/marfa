import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABS } from "../../scripts/ui-viewer-fixtures.js";

const ROUTES = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = fileURLToPath(
  new URL("../../scripts/ui-viewer-fixtures.tsx", import.meta.url),
);

/** Exports that draw a fragment of a page, not a page, with the reason. */
const NOT_PREVIEWED: Record<string, string> = {};

const isSource = (name: string): boolean =>
  /\.tsx?$/.test(name) &&
  !/\.test\.tsx?$/.test(name) &&
  name !== "test-render.ts";

function renderers(): string[] {
  return readdirSync(ROUTES)
    .filter(isSource)
    .flatMap((name) =>
      [
        ...readFileSync(join(ROUTES, name), "utf8").matchAll(
          /^export (?:async )?(?:function|const) (render[A-Z]\w*)/gm,
        ),
      ].map((found) => found[1] ?? ""),
    );
}

describe("the UI viewer's examples", () => {
  it("reach every page a route draws", () => {
    const fixtures = readFileSync(FIXTURES, "utf8");
    const all = renderers();
    // Witness: the scan finds renderers, and finds one the examples do call.
    expect(all.length).toBeGreaterThan(40);
    expect(all).toContain("renderRootPage");
    const unreached = all.filter(
      (name) =>
        !(name in NOT_PREVIEWED) && !new RegExp(`\\b${name}\\(`).test(fixtures),
    );
    expect(
      unreached,
      "add a variant for each in ui-viewer-fixtures.tsx",
    ).toEqual([]);
  });

  it("draw a whole document for every variant", () => {
    const variants = TABS.flatMap((tab) =>
      tab.screens.flatMap((screen) => [
        ...screen.variants,
        ...(screen.designVariants ?? []),
      ]),
    );
    expect(variants.length).toBeGreaterThan(100);
    for (const variant of variants)
      expect(variant.render(), variant.label).toMatch(/^<!doctype html>/i);
  });
});
