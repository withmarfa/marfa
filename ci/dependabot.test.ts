/**
 * Dependabot updates an npm folder by running `pnpm update -r` in it, and pnpm
 * works in the nearest workspace it finds above. A folder the root workspace
 * does not list, and that has no workspace file of its own, is updated as the
 * root's packages are and ends in "No files were updated".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Update {
  "package-ecosystem": string;
  directory: string;
}

const updates = (
  parse(readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8")) as {
    updates: Update[];
  }
).updates;

describe("Dependabot's npm folders", () => {
  it("has a folder outside the root workspace, as the witness", () => {
    const folders = updates
      .filter((entry) => entry["package-ecosystem"] === "npm")
      .map((entry) => entry.directory);
    expect(folders).toContain("/core/bindings/node");
  });

  it("gives each folder but the root a workspace file of its own", () => {
    const missing = updates
      .filter(
        (entry) =>
          entry["package-ecosystem"] === "npm" && entry.directory !== "/",
      )
      .map((entry) => entry.directory.slice(1))
      .filter(
        (folder) => !existsSync(join(ROOT, folder, "pnpm-workspace.yaml")),
      );
    expect(missing).toEqual([]);
  });
});
