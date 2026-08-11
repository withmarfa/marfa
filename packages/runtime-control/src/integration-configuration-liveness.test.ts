/**
 * Every configuration key an integration declares must be read by its own
 * handler code.
 *
 * The declare-what-you-read contract was previously held by one literal
 * assertion in one integration's test file, so it generalized to nothing:
 * three integrations accumulated declared keys no code read, one of which
 * silently did nothing when set. A declared key is a promise on the
 * configure screen — the user sets it and something changes — so a key
 * nothing reads is a lie in the UI, not just dead metadata.
 *
 * The check is textual on purpose. Handlers read configuration through
 * plain property access on a narrowed object (`cfg.feed_url`,
 * `cfg.target_type`), so the key literal appearing in the handler sources
 * is the observable trace of a read, and its absence is exactly the drift
 * this exists to catch. A textual hit can lie in principle (the key named
 * only in a comment), which is why removals still get a human decision —
 * this test's job is to force that decision to happen.
 *
 * Lives here for the same reason the sibling worker-surface tests do:
 * this package's tests already walk `integrations/` with `node:fs`, and
 * the contract spans every integration rather than belonging to any one.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations",
);

/**
 * Declared keys that legitimately have no read in that integration's
 * handlers, each with the reason it stays declared. Empty today, and the
 * emptiness is the point: an entry here is a decision with a name on it,
 * not a hole.
 */
const DECLARED_BUT_UNREAD_EXCEPTIONS: Record<
  string,
  Record<string, string>
> = {};

type ManifestModule = Record<string, unknown>;

function looksLikeManifest(
  value: unknown,
): value is { name: string; configuration_schema?: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { manifest_schema_version?: unknown })
      .manifest_schema_version === "string"
  );
}

function integrationDirs(): string[] {
  return readdirSync(INTEGRATIONS_ROOT).filter((entry) => {
    if (entry === "node_modules" || entry === "dist") return false;
    const dir = join(INTEGRATIONS_ROOT, entry);
    return (
      statSync(dir).isDirectory() && existsSync(join(dir, "src", "manifest.ts"))
    );
  });
}

/** Every non-test TypeScript source in the integration except the
 *  manifest itself, concatenated. The manifest is excluded so a key's own
 *  declaration can never satisfy the read check. */
function handlerSources(dir: string): string {
  const srcDir = join(INTEGRATIONS_ROOT, dir, "src");
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (entry === "manifest.ts") continue;
      files.push(full);
    }
  };
  walk(srcDir);
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("declared configuration keys are read configuration keys", () => {
  const dirs = integrationDirs();

  it("finds the integrations at all", () => {
    // A path regression here would otherwise pass every per-integration
    // case vacuously.
    expect(dirs.length).toBeGreaterThanOrEqual(10);
  });

  for (const dir of dirs) {
    it(`${dir}: every declared key appears in its handler sources`, async () => {
      const module = (await import(
        join(INTEGRATIONS_ROOT, dir, "src", "manifest.ts")
      )) as ManifestModule;
      const manifest = Object.values(module).find(looksLikeManifest);
      expect(manifest, `${dir}: no manifest export found`).toBeDefined();

      const declared = Object.keys(manifest?.configuration_schema ?? {});
      if (declared.length === 0) return;

      const sources = handlerSources(dir);
      const exceptions = DECLARED_BUT_UNREAD_EXCEPTIONS[dir] ?? {};
      const unread = declared.filter(
        (key) =>
          !(key in exceptions) &&
          !new RegExp(
            `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          ).test(sources),
      );
      expect(
        unread,
        `${dir} declares configuration nothing reads: ${unread.join(", ")}. ` +
          `Wire each key or remove it; a deliberate exception belongs in ` +
          `DECLARED_BUT_UNREAD_EXCEPTIONS with its reason.`,
      ).toEqual([]);
    });
  }
});
