/**
 * The contributor documentation's list of integrations, held to the
 * directory.
 *
 * There were four hand-maintained enumerations of the integration set and
 * nothing kept them in agreement; they agreed by attention. Three are gone:
 * the shared array, the seeding script's copy, and the runtime loader's
 * hardcoded scaffold entry, all replaced by reading the directory.
 *
 * This one stays, because it is the only one that carries something a
 * directory scan cannot produce — a line saying what each integration
 * actually does. Deleting it to reach one enumeration would trade real
 * documentation for a tidy count.
 *
 * So it is checked instead. The directory is the source; the prose has to
 * agree with it. A new integration that nobody documented fails here, and a
 * bullet for something that no longer exists fails here too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIntegrationDirs } from "./discover.js";

const INTEGRATIONS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../integrations",
);

/** The scaffold is documented on purpose and is deliberately not an
 *  integration, so discovery skips it and the prose still names it. */
const SCAFFOLD = "_template";

function documentedDirs(): string[] {
  const md = readFileSync(resolve(INTEGRATIONS_ROOT, "AGENTS.md"), "utf8");
  const section = md.slice(md.indexOf("## In-tree integrations"));
  const end = section.indexOf("\n## ", 1);
  const body = end === -1 ? section : section.slice(0, end);
  return [...body.matchAll(/^- \*\*`([^`]+)`\*\*/gm)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string")
    .sort();
}

describe("the in-tree integration list in integrations/AGENTS.md", () => {
  it("names every integration the directory holds, and nothing else", () => {
    const onDisk = [
      SCAFFOLD,
      ...discoverIntegrationDirs(INTEGRATIONS_ROOT),
    ].sort();
    expect(documentedDirs()).toEqual(onDisk);
  });

  it("says something about each one, rather than just listing it", () => {
    const md = readFileSync(resolve(INTEGRATIONS_ROOT, "AGENTS.md"), "utf8");
    for (const dir of documentedDirs()) {
      const line = md.split("\n").find((l) => l.startsWith(`- **\`${dir}\`**`));
      expect(line, `no bullet for ${dir}`).toBeDefined();
      // The em-dash description, not merely the name. A bullet that is only
      // a name is the enumeration coming back without the thing that
      // justified keeping it.
      expect((line ?? "").length, `${dir} has no description`).toBeGreaterThan(
        `- **\`${dir}\`** — `.length + 20,
      );
    }
  });
});
