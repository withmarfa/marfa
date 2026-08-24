/**
 * The declaration of what the image installs, held to the directory.
 *
 * The image used to assert its own completeness with a hardcoded minimum
 * count, which had to be raised by hand whenever the set grew and passed
 * silently whenever the set grew without anybody raising it. The
 * declaration answers the same question properly, but only while it agrees
 * with reality, and an image build is a slow and distant place to find out
 * that it does not.
 *
 * So it is checked here, in the ordinary suite. Adding an integration and
 * forgetting to declare it fails in seconds rather than on a merge, and
 * removing one stays a deliberate edit rather than a directory quietly
 * getting smaller.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIntegrationDirs } from "./discover.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DECLARATION = resolve(SERVER_ROOT, "installed-integrations.txt");
const INTEGRATIONS_ROOT = resolve(SERVER_ROOT, "../../integrations");

/** The same parse the Dockerfile and the in-image verification perform:
 *  a comment runs to the end of its line, and blanks are ignored. */
function declared(): string[] {
  return readFileSync(DECLARATION, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0)
    .sort();
}

describe("the installed-integrations declaration", () => {
  it("names every integration the directory holds, and nothing else", () => {
    expect(declared()).toEqual(discoverIntegrationDirs(INTEGRATIONS_ROOT));
  });

  it("does not declare the scaffold", () => {
    // It ships as a dispatch fixture the image throws away, not as an
    // integration. Declaring it would put it back in the substrate, which
    // is where it spent a long time being registered by accident.
    expect(declared()).not.toContain("_template");
  });

  it("names each integration once", () => {
    const names = declared();
    expect(names).toEqual([...new Set(names)]);
  });
});
