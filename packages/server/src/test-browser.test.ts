import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromiumCandidates } from "./test-browser.js";

const BUNDLE = "Google Chrome for Testing.app/Contents/MacOS";
const MAC = "Google Chrome for Testing";

let dirs: string[] = [];

function install(root: string, build: string, ...path: string[]): string {
  const dir = join(root, build, ...path);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, path.at(-1) === "chrome-linux" ? "chrome" : MAC);
  writeFileSync(file, "");
  return file;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-test-browser-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("where a test finds Chromium", () => {
  it("looks in the browsers path for a Linux build, newest first", () => {
    const root = scratch();
    const older = install(root, "chromium-999", "chrome-linux");
    const newer = install(root, "chromium-1248", "chrome-linux");
    expect(
      chromiumCandidates({ PLAYWRIGHT_BROWSERS_PATH: root }, "linux", "/none"),
    ).toEqual([newer, older]);
  });

  it("looks for Chrome for Testing under the browsers path on macOS, newest first", () => {
    const root = scratch();
    const older = install(root, "chromium-999", "chrome-mac-arm64", BUNDLE);
    const newer = install(root, "chromium-1248", "chrome-mac-arm64", BUNDLE);
    expect(
      chromiumCandidates(
        { PLAYWRIGHT_BROWSERS_PATH: root },
        "darwin",
        "/none",
        "arm64",
      ),
    ).toEqual([newer, older]);
  });

  it("falls back to Playwright's cache in the home folder on macOS", () => {
    const home = scratch();
    const root = join(home, "Library", "Caches", "ms-playwright");
    const found = install(root, "chromium-1248", "chrome-mac-arm64", BUNDLE);
    expect(chromiumCandidates({}, "darwin", home, "arm64")).toEqual([found]);
    // The witness that the macOS path is what finds it.
    expect(chromiumCandidates({}, "linux", home, "arm64")).toEqual([]);
  });

  it("puts a browser named by the environment first and skips what is not there", () => {
    const root = scratch();
    const named = join(root, "named-chrome");
    writeFileSync(named, "");
    const found = install(root, "chromium-1", "chrome-mac-arm64", BUNDLE);
    expect(
      chromiumCandidates(
        {
          MARFA_TEST_BROWSER: named,
          PLAYWRIGHT_BROWSERS_PATH: root,
        },
        "darwin",
        "/none",
        "arm64",
      ),
    ).toEqual([named, found]);
    expect(
      chromiumCandidates(
        { MARFA_TEST_BROWSER: join(root, "missing") },
        "darwin",
        "/none",
      ),
    ).toEqual([]);
  });
});
