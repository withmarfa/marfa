/**
 * An integration's package name, held to its manifest identifier.
 *
 * **The rule.** A package name is the manifest identifier with the slash
 * flattened to a hyphen, unscoped. `google/calendar` is `google-calendar`.
 *
 * **Why the flattening rather than a second name.** npm permits a slash
 * only between a scope and a name, so the identifier cannot be a package
 * name verbatim. The flattened form is therefore the same name in the only
 * encoding npm accepts, not an independent one that has to be kept in
 * agreement — which is the difference this test exists to preserve.
 *
 * **Why unscoped.** `@withmarfa` is the scope this repository publishes
 * into. No integration publishes; every one of them is `private: true`. A
 * name in that scope is a claim that is not true, and the prefix that used
 * to follow it (`integration-`) existed only so a wildcard filter could
 * select these packages. The image build selects them by path now, so
 * nothing needs a shared prefix and nothing should grow one back.
 *
 * **What this catches that reading the names cannot.** The old names were
 * not simply the identifier with a prefix: `raindrop/bookmarks` was
 * `integration-raindrop`, `readwise/highlights` was `integration-readwise`,
 * `todoist/tasks` was `integration-todoist`, and the four `marfa/*`
 * integrations had dropped the handle entirely. Every one of those looked
 * plausible in isolation. A name and an identifier that merely resemble
 * each other drift silently, because nothing reads both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

interface IntegrationPackage {
  /** Path relative to the repo root, for failure messages. */
  dir: string;
  absDir: string;
  packageName: string;
  /** The manifest's `name`, or null when the package ships no manifest. */
  identifier: string | null;
}

/**
 * Every directory under `integrations/` holding a package.json, at any
 * depth. Walking rather than globbing two fixed levels: the nested email
 * worker sits at a third, and a rule that only inspected the depths it
 * expected would let a new package at another one escape it entirely.
 */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = resolve(dir, entry.name);
    if (existsSync(resolve(child, "package.json"))) found.push(child);
    found.push(...walk(child));
  }
  return found;
}

/**
 * Read the identifier out of the manifest source rather than importing it.
 * Most manifests import from `@withmarfa/shared`, so importing fifteen of
 * them to read one string each would make this test's cost and its failure
 * modes those of the module graph rather than of the names.
 */
function readIdentifier(absDir: string): string | null {
  const manifest = resolve(absDir, "src", "manifest.ts");
  if (!existsSync(manifest)) return null;
  const match = /^\s*name:\s*"([^"]+)"/m.exec(readFileSync(manifest, "utf8"));
  // A manifest whose name this cannot find is a failure, not a skip: the
  // silent version of that is a package quietly exempt from the rule.
  if (!match?.[1]) {
    throw new Error(
      `${relative(REPO_ROOT, manifest)} has a manifest but no readable ` +
        `\`name:\` field, so its package name cannot be checked`,
    );
  }
  return match[1];
}

const packages: IntegrationPackage[] = walk(INTEGRATIONS_ROOT)
  .map((absDir) => ({
    dir: relative(REPO_ROOT, absDir),
    absDir,
    packageName: (
      JSON.parse(
        readFileSync(resolve(absDir, "package.json"), "utf8"),
      ) as Record<string, unknown>
    ).name as string,
    identifier: readIdentifier(absDir),
  }))
  .sort((a, b) => a.dir.localeCompare(b.dir));

describe("integration package names", () => {
  it("finds the integration packages at all", () => {
    // Guards the walk itself. Every assertion below passes vacuously on an
    // empty list, so a walk that silently found nothing would report a
    // green suite having checked no names.
    expect(packages.length).toBeGreaterThan(1);
  });

  it("names each package after its manifest identifier", () => {
    const withManifest = packages.filter((p) => p.identifier !== null);
    expect(
      withManifest.map((p) => `${p.dir}: ${p.packageName}`).sort(),
    ).toEqual(
      withManifest
        .map((p) => `${p.dir}: ${(p.identifier ?? "").replace("/", "-")}`)
        .sort(),
    );
  });

  it("keeps the flattened names unique", () => {
    // `a/b-c` and `a-b/c` both flatten to `a-b-c`. Nothing collides today,
    // and the flattening is only a safe encoding for as long as that holds
    // — two integrations resolving to one package name would be a build
    // that silently drops one of them.
    const names = packages.map((p) => p.packageName);
    expect(names.length).toBe(new Set(names).size);
  });

  it("leaves every one of them unscoped", () => {
    // The scope is the claim that made the old names wrong. Nothing here
    // publishes, so nothing here carries a publishing scope.
    expect(packages.filter((p) => p.packageName.startsWith("@"))).toEqual([]);
  });

  it("accounts for the one package that ships no manifest of its own", () => {
    // The email worker is a second deployable belonging to the integration
    // above it, so it has no identifier to derive from and takes its
    // parent's flattened name plus what it is. Naming it here rather than
    // skipping manifest-less packages generally is the point: a new
    // package that forgot its manifest would otherwise be exempt from
    // every assertion above without anyone noticing.
    const withoutManifest = packages.filter((p) => p.identifier === null);
    expect(withoutManifest.map((p) => p.dir)).toEqual([
      "integrations/marfa/inbox/email-worker",
    ]);
    expect(withoutManifest[0]?.packageName).toBe("marfa-inbox-email-worker");
  });
});
