/**
 * Every in-tree Worker entry is built on the gated bootstrap.
 *
 * `createIntegrationWorker(...)` is where the `fetch` surface gets its
 * broker-key check and its 404 for unknown paths. An entry that
 * exports its own handler object gets neither, and nothing else in the
 * repository would say so: the Wrangler config freshness check reads
 * hostnames, the outbound-header check reads the control plane, and
 * neither looks at what an integration exports.
 *
 * The scaffold is why this is a test rather than a convention. It is
 * the file contributors copy to start an integration, so a defect
 * sitting in it is the one defect that reproduces itself, once per new
 * connector, each time looking like the house style.
 *
 * Asserting the default export rather than the absence of the word
 * `fetch`: a hand-rolled surface has to be exported to be served, and
 * the export line is the one place every shape of it converges.
 *
 * Entries are found by walking `integrations/` rather than read off
 * the registry, so an integration that ships a Worker without a
 * registry entry is still checked, the same reasoning as the config
 * freshness test beside this one. It lives in
 * `@withmarfa/runtime-control` for the same reason that one does: it
 * needs `node:fs`, and `@withmarfa/runtime-sdk`, where the bootstrap
 * itself lives, deliberately compiles against Workers types only.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

/**
 * The standard entry path. A deployable that answers by some other
 * route has no `src/worker.ts` and is out of scope here by
 * construction: the withmarfa-inbox Email Worker, whose entry is
 * `src/index.ts` and whose only handler is `email`, is the one such
 * deployable in the tree.
 */
const ENTRY = join("src", "worker.ts");

function workerEntries(): { label: string; path: string }[] {
  const found: { label: string; path: string }[] = [];
  for (const entry of readdirSync(INTEGRATIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(INTEGRATIONS_ROOT, entry.name, ENTRY);
    if (!existsSync(path)) continue;
    found.push({ label: relative(REPO_ROOT, path), path });
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

const ENTRIES = workerEntries();

describe("per-Integration Worker entries use the gated bootstrap", () => {
  it("has entries to check, the scaffold among them", () => {
    // Vacuity guard. A walk that finds nothing, or one that quietly
    // stops reaching `_template`, would leave the assertion below
    // passing against no Worker at all.
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(ENTRIES.map((e) => e.label)).toContain(
      join("integrations", "_template", ENTRY),
    );
  });

  it.each(ENTRIES)("$label", ({ path }) => {
    expect(readFileSync(path, "utf8")).toMatch(
      /^export default createIntegrationWorker\(/mu,
    );
  });
});
