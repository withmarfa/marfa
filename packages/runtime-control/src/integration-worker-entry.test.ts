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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

/**
 * The standard entry filename. A deployable that answers by some other
 * route has no `worker.ts` and is out of scope here by construction:
 * the withmarfa-inbox Email Worker, whose entry is `src/index.ts` and
 * whose only handler is `email`, is the one such deployable today.
 */
const ENTRY = "worker.ts";

/**
 * Every `src/worker.ts` under `integrations/`, found by walking rather
 * than by joining a known depth. Integrations are one level down today
 * and the sibling Email Worker is two, so a per-Integration Worker
 * nested the same way is a shape the tree already has, and a guard
 * that only looks where it expects is the same blind spot as one that
 * counts files instead of call sites.
 */
function workerEntries(): { label: string; path: string }[] {
  const found: { label: string; path: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Build output and installed packages carry other projects' code.
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path);
      } else if (entry.name === ENTRY && dirname(path).endsWith(`${sep}src`)) {
        found.push({ label: relative(REPO_ROOT, path), path });
      }
    }
  };
  walk(INTEGRATIONS_ROOT);
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
      join("integrations", "_template", "src", ENTRY),
    );
  });

  it.each(ENTRIES)("$label", ({ path }) => {
    expect(readFileSync(path, "utf8")).toMatch(
      /^export default createIntegrationWorker\(/mu,
    );
  });
});
