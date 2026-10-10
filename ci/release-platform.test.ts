/**
 * `@withmarfa/core` ships one native binary, built on the macOS release
 * runner, so its manifest has to say it installs only there. The release
 * refuses a packed tarball whose manifest does not.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOLD_PLATFORM = join(ROOT, "scripts", "release", "hold-platform.sh");

/** Packs `manifest` as the `package/package.json` of a tarball and runs the hold. */
function hold(manifest: object, os: string, cpu: string): void {
  const directory = mkdtempSync(join(tmpdir(), "marfa-hold-platform-"));
  try {
    mkdirSync(join(directory, "package"));
    writeFileSync(
      join(directory, "package", "package.json"),
      JSON.stringify(manifest),
    );
    execFileSync("tar", ["-czf", "pack.tgz", "package"], { cwd: directory });
    execFileSync(
      "bash",
      [HOLD_PLATFORM, join(directory, "pack.tgz"), os, cpu],
      {
        stdio: "pipe",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the Node package installs only where its binary runs", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(ROOT, "core", "bindings", "node", "package.json"),
      "utf8",
    ),
  ) as { os?: string[]; cpu?: string[] };

  it("declares the platform the release builds it on", () => {
    expect(manifest.os).toEqual(["darwin"]);
    expect(manifest.cpu).toEqual(["arm64"]);
  });

  it("is held to that platform by the release's pack step", () => {
    const workflow = readFileSync(
      join(ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(workflow).toMatch(
      /hold-platform\.sh"[^\n]*withmarfa-core-\$VERSION\.tgz" \\\n\s+darwin arm64/,
    );
  });

  it("accepts a tarball that declares the platform", () => {
    expect(() => {
      hold({ name: "x", os: ["darwin"], cpu: ["arm64"] }, "darwin", "arm64");
    }).not.toThrow();
  });

  it.each([
    ["no platform", { name: "x" }],
    ["no cpu", { name: "x", os: ["darwin"] }],
    ["another cpu", { name: "x", os: ["darwin"], cpu: ["x64"] }],
    [
      "more than one os",
      { name: "x", os: ["darwin", "linux"], cpu: ["arm64"] },
    ],
  ])("refuses a tarball with %s", (_name, declared) => {
    expect(() => {
      hold(declared, "darwin", "arm64");
    }).toThrow();
  });
});
