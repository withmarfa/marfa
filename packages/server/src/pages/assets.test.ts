/**
 * The stylesheet and script are built from sources by
 * `scripts/build-page-assets.ts` into `assets.generated.ts`, which Git
 * ignores. The tests' global setup writes it before any file runs, so these
 * tests see what the sources build to now.
 */
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPageAssets,
  renderGeneratedModule,
  writePageAssets,
} from "../../scripts/build-page-assets.js";
import { PAGE_ASSETS, pageAssetUrl } from "./assets.js";

const GENERATED = fileURLToPath(
  new URL("./assets.generated.ts", import.meta.url),
);
const sha1 = (text: string): string =>
  createHash("sha1").update(text).digest("hex");

describe("the generated page assets", () => {
  it("are what the sources build to now", async () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(
      renderGeneratedModule(await buildPageAssets()),
    );
    // Nothing is left to write, so no process rewrites the file under another.
    expect(await writePageAssets()).toBe(false);
  }, 60_000);

  it("are written whole, and only when they differ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marfa-assets-"));
    const target = join(dir, "assets.generated.ts");
    try {
      const expected = renderGeneratedModule(await buildPageAssets());

      // Witness: a missing file and a stale one are both written.
      expect(await writePageAssets(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(expected);
      writeFileSync(target, "// stale\n");
      expect(await writePageAssets(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(expected);

      const written = statSync(target).mtimeMs;
      expect(await writePageAssets(target)).toBe(false);
      expect(statSync(target).mtimeMs).toBe(written);
      expect(readdirSync(dir)).toEqual(["assets.generated.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
