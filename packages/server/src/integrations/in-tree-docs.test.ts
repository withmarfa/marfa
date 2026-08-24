/**
 * The contributor documentation's lists of integrations, held to the
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
 *
 * Two documents enumerate the set, and for a while only one of them was
 * checked. The root AGENTS.md groups the same integrations by direction, and
 * having no guard it went on naming directories that had stopped existing,
 * contradicting a sentence three lines above it. An enumeration nothing
 * checks is the thing this file exists against, so both are checked here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIntegrationDirs } from "./discover.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

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

/**
 * Every integration named in the root AGENTS.md's direction bullets.
 *
 * The bullets only, not the paragraph introducing them: that backticks
 * `integrations/`, `<namespace>/<name>` and `_template`, none of which is an
 * integration, and two of which carry a slash.
 */
function rootAgentsNames(): string[] {
  const lines = readFileSync(resolve(REPO_ROOT, "AGENTS.md"), "utf8").split(
    "\n",
  );
  const start = lines.findIndex((l) => l.startsWith("**In-tree Integrations"));
  if (start === -1) {
    throw new Error("the in-tree Integrations paragraph is no longer there");
  }
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) continue;
    if (!line.startsWith("- **")) break;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      if (match[1]?.includes("/")) names.push(match[1]);
    }
  }
  return names.sort();
}

describe("the in-tree integration list in the root AGENTS.md", () => {
  it("names every integration the directory holds, and nothing else", () => {
    expect(rootAgentsNames()).toEqual(
      discoverIntegrationDirs(INTEGRATIONS_ROOT),
    );
  });

  // The paragraph above the bullets states the count in words, which is the
  // same claim in another form and goes stale the same way.
  it("states the count the directory actually holds", () => {
    const md = readFileSync(resolve(REPO_ROOT, "AGENTS.md"), "utf8");
    const count = discoverIntegrationDirs(INTEGRATIONS_ROOT).length;
    const words = [
      "ten",
      "eleven",
      "twelve",
      "thirteen",
      "fourteen",
      "fifteen",
      "sixteen",
      "seventeen",
      "eighteen",
      "nineteen",
      "twenty",
    ];
    const word = words[count - 10];
    expect(
      word,
      `no number word for ${String(count)}; extend the list`,
    ).toBeDefined();
    expect(md).toContain(`${String(word)} shipping Integrations`);
  });
});

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
