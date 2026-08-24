/**
 * Discovery, which is the one static thing that stood between a deployment
 * and installing an integration it did not build.
 *
 * The runtime has always loaded integrations dynamically. What it could not
 * do was name one it had never heard of, because the set came from a
 * hand-maintained array in the shared package. These pin the replacement's
 * two halves: what counts as an integration directory, and that a package
 * dropped into the directory by hand is found on the next boot without
 * anybody editing a list.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverIntegrationDirs } from "./discover.js";
import { loadInTreeManifests } from "./load-manifests.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "marfa-discover-"));
  return root;
}

/** Write a built entry exporting a manifest, which is what discovery's
 *  callers then read. `dist/local.js` is the handler entry. */
function installIntegration(
  at: string,
  dirName: string,
  manifest: Record<string, unknown> | null,
): void {
  const dist = join(at, dirName, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "local.js"),
    manifest === null
      ? "export const manifest = { nope: true };\n"
      : `export const manifest = ${JSON.stringify(manifest)};\n`,
  );
}

/** The smallest manifest the validator accepts, so a failure here is the
 *  loader's judgement rather than a fixture that was never going to pass. */
function manifestFor(name: string): Record<string, unknown> {
  return {
    manifest_schema_version: "2.0.0",
    name,
    version: "1.0.0",
    publisher: name.split("/")[0],
    description: "An integration nobody listed.",
    direction: "read",
    target_types: ["core.note"],
    triggers: [{ type: "manual" }],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
  };
}

describe("discoverIntegrationDirs", () => {
  it("returns every subdirectory, sorted", () => {
    const at = scratch();
    for (const d of ["zebra", "alpha", "middle"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("ignores files beside the directories", () => {
    const at = scratch();
    mkdirSync(join(at, "real"), { recursive: true });
    writeFileSync(join(at, "AGENTS.md"), "# not an integration\n");
    writeFileSync(join(at, "manifest-lock.json"), "{}\n");
    expect(discoverIntegrationDirs(at)).toEqual(["real"]);
  });

  // The scaffold shipped as a dispatchable integration on every deployment
  // under the old arrangement, because the runtime loader prepended it by
  // hand. Reading the directory naively would have promoted it further, into
  // the installable catalog.
  it("skips scaffolding, which is what a leading dot or underscore means", () => {
    const at = scratch();
    for (const d of ["_template", ".turbo", "podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["podcasts"]);
  });

  // A server with no integrations is an ordinary configuration — a SQLite
  // deployment, a test harness pointed at a scratch path. Saying "none" is
  // the honest answer; throwing would make it look broken.
  it("answers none for a root that does not exist", () => {
    expect(
      discoverIntegrationDirs(join(tmpdir(), "marfa-no-such-root")),
    ).toEqual([]);
  });
});

describe("an integration nobody listed", () => {
  // The whole point of the change: this is a package a deployment installed,
  // which no array in this repository has ever mentioned.
  it("is discovered and loaded from the directory alone", async () => {
    const at = scratch();
    installIntegration(at, "someone-elses", manifestFor("someone/thing"));

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/thing"]);
    expect(result.skipped).toEqual([]);
  });

  it("is skipped with a reason when its manifest is invalid, and the rest still load", async () => {
    const at = scratch();
    installIntegration(at, "good", manifestFor("someone/good"));
    installIntegration(at, "broken", null);

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/good"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.dirName).toBe("broken");
    // The reason has to say what was wrong, not merely that something was.
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it("is skipped with a reason when it has no built entry at all", async () => {
    const at = scratch();
    mkdirSync(join(at, "source-only", "src"), { recursive: true });
    installIntegration(at, "built", manifestFor("someone/built"));

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/built"]);
    expect(result.skipped.map((s) => s.dirName)).toEqual(["source-only"]);
  });
});
