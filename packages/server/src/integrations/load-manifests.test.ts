/**
 * The catalog's manifest loader, read off a scratch integrations tree.
 *
 * Its skip list is the thing worth pinning. At boot a skip is one warn line
 * and an integration quietly missing from the catalog, so nothing fails and
 * nothing is red; the in-image verification is what turns a skip into a
 * build failure, and it can only do that if the reasons here are the ones
 * it expects. Every path that produces a skip is driven below, by the fault
 * that produces it rather than by a stub.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInTreeManifests } from "./load-manifests.js";

let scratchRoot: string | undefined;

afterEach(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = undefined;
});

/** A manifest the schema accepts, which is a good deal more than the three
 *  fields the export search duck-types on. */
function validManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    publisher: "acme",
    description: "A scratch integration",
    direction: "read",
    triggers: [{ type: "schedule", config: { cron: "*/15 * * * *" } }],
    target_types: ["core.event"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: { "calendar.read": "proxy" },
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
  };
}

/**
 * A scratch integrations root. Each entry is `<namespace>/<name>` with an
 * optional `!shape`: `manifest` builds `dist/manifest.js` instead of
 * `dist/local.js`, `empty` builds nothing, `bare` exports no manifest,
 * `broken` throws on import, `invalid` exports a manifest the schema
 * refuses, and `misfiled` exports one naming a different integration.
 */
function tree(entries: string[]): string {
  scratchRoot = mkdtempSync(join(tmpdir(), "marfa-load-manifests-"));
  writeFileSync(join(scratchRoot, "package.json"), '{"type":"module"}\n');
  const root = join(scratchRoot, "integrations");
  mkdirSync(root, { recursive: true });
  for (const raw of entries) {
    const [name, shape] = raw.split("!");
    const dir = join(root, name ?? raw);
    mkdirSync(dir, { recursive: true });
    if (shape === "empty") continue;
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const file = join(dist, shape === "manifest" ? "manifest.js" : "local.js");
    if (shape === "bare") {
      writeFileSync(file, "export const somethingElse = 1;\n");
      continue;
    }
    if (shape === "broken") {
      writeFileSync(file, 'throw new Error("this entry is not loadable");\n');
      continue;
    }
    const manifest =
      shape === "invalid"
        ? { ...validManifest(name ?? raw), triggers: [{ type: "eclipse" }] }
        : shape === "misfiled"
          ? validManifest("other/elsewhere")
          : validManifest(name ?? raw);
    writeFileSync(
      file,
      `export const manifest = ${JSON.stringify(manifest)};\n`,
    );
  }
  return root;
}

describe("loadInTreeManifests", () => {
  it("reads a handler entry's manifest", async () => {
    const root = tree(["acme/alpha"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.skipped).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]?.name).toBe("acme/alpha");
    expect(result.manifests[0]?.dirName).toBe("acme/alpha");
  });

  it("reads a manifest-only entry, which builds no handler", async () => {
    const root = tree(["acme/beta!manifest"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.skipped).toEqual([]);
    expect(result.manifests[0]?.name).toBe("acme/beta");
  });

  it("takes the directories it is given over the ones it would find", async () => {
    const root = tree(["acme/alpha", "acme/beta"]);
    const result = await loadInTreeManifests({
      integrationsRoot: root,
      integrationDirs: ["acme/alpha"],
    });
    expect(result.manifests).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("reports a directory that built nothing", async () => {
    const root = tree(["acme/alpha!empty"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.manifests).toEqual([]);
    expect(result.skipped[0]?.dirName).toBe("acme/alpha");
    expect(result.skipped[0]?.reason).toMatch(/no built manifest entry/);
  });

  it("reports an entry that throws on import", async () => {
    const root = tree(["acme/alpha!broken"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.manifests).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/import failed/);
    expect(result.skipped[0]?.reason).toMatch(/not loadable/);
  });

  it("reports an entry that exports no manifest", async () => {
    const root = tree(["acme/alpha!bare"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.manifests).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no manifest export found/);
  });

  it("reports a manifest the schema refuses, naming the field", async () => {
    // The skip the in-image verification turns into a build failure. At
    // boot it is a warn line, and the catalog comes up one integration
    // short with nothing else saying so.
    const root = tree(["acme/alpha!invalid"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.manifests).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/manifest failed validation/);
    expect(result.skipped[0]?.reason).toMatch(/triggers/);
  });

  it("keeps reading after a skip", async () => {
    // A short catalog is the failure mode, so one bad entry must not cost
    // the ones after it.
    const root = tree(["acme/alpha!bare", "acme/beta", "acme/gamma!empty"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.manifests.map((m) => m.name)).toEqual(["acme/beta"]);
    expect(result.skipped.map((s) => s.dirName)).toEqual([
      "acme/alpha",
      "acme/gamma",
    ]);
  });

  it("reports the name and the directory separately when they disagree", async () => {
    // Tolerated here, because a deployment may install into whatever
    // directory it likes. The image build is where it is refused, and it
    // can only refuse it because both are carried.
    const root = tree(["acme/alpha!misfiled"]);
    const result = await loadInTreeManifests({ integrationsRoot: root });
    expect(result.skipped).toEqual([]);
    expect(result.manifests[0]?.dirName).toBe("acme/alpha");
    expect(result.manifests[0]?.name).toBe("other/elsewhere");
  });

  it("reads an absent root as an empty tree", async () => {
    const root = tree([]);
    const result = await loadInTreeManifests({
      integrationsRoot: join(root, "absent"),
    });
    expect(result).toEqual({ manifests: [], skipped: [] });
  });
});
