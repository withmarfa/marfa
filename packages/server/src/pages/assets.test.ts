/**
 * The stylesheet and script are built from sources by
 * `scripts/build-page-assets.ts` and committed as `assets.generated.ts`, which
 * `build`, `dev` and the tests all serve. This fails when the committed file
 * no longer matches its sources, so none of the three can serve stale bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPageAssets,
  renderGeneratedModule,
} from "../../scripts/build-page-assets.js";
import { PAGE_ASSETS, pageAssetUrl } from "./assets.js";

const GENERATED = fileURLToPath(
  new URL("./assets.generated.ts", import.meta.url),
);
const sha1 = (text: string): string =>
  createHash("sha1").update(text).digest("hex");

describe("the generated page assets", () => {
  it("are what the sources build to now", async () => {
    const built = await buildPageAssets();
    expect(
      sha1(readFileSync(GENERATED, "utf8")),
      "assets.generated.ts is stale; run `pnpm --filter @withmarfa/server assets:build`",
    ).toBe(sha1(renderGeneratedModule(built)));
  }, 60_000);

  it("would be caught if a source changed and nobody rebuilt", async () => {
    const built = await buildPageAssets();
    const committed = readFileSync(GENERATED, "utf8");
    expect(
      renderGeneratedModule({ ...built, css: `${built.css}.x{}` }),
    ).not.toBe(committed);
    expect(renderGeneratedModule({ ...built, js: `${built.js};0` })).not.toBe(
      committed,
    );
  }, 60_000);

  it("carry the hash of their own bytes", () => {
    for (const asset of Object.values(PAGE_ASSETS))
      expect(asset.version).toBe(sha1(asset.body));
  });

  it("name themselves by that hash in the URL a page loads", () => {
    expect(pageAssetUrl("pages.css")).toBe(
      `/auth/static/pages.css?v=${PAGE_ASSETS["pages.css"].version}`,
    );
    expect(pageAssetUrl("pages.js")).toMatch(
      /^\/auth\/static\/pages\.js\?v=[0-9a-f]{40}$/,
    );
  });

  it("hold the tokens and the parts, and the modules, in two files", () => {
    const css = PAGE_ASSETS["pages.css"].body;
    expect(css).toContain("--bg:");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain(".btn");
    const js = PAGE_ASSETS["pages.js"].body;
    for (const hook of [
      "data-dialog-open",
      "data-picker-button",
      "data-command-search",
      "data-password",
      "data-submitting",
    ])
      expect(js, hook).toContain(hook);
  });

  it("need nothing the policy forbids: no imports, no eval", () => {
    const js = PAGE_ASSETS["pages.js"].body;
    // Witness: the patterns are in a script that does what they describe.
    expect("import('/x.js'); eval('1')").toMatch(/\bimport\s*\(/);
    expect("import('/x.js'); eval('1')").toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/^import\s|\bimport\s*\(|\brequire\s*\(/);
    expect(js).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});
