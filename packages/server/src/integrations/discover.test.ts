/**
 * Discovery, which is what lets a deployment install an integration it did
 * not build.
 *
 * The set comes from the directory, not from a list, and these pin the two
 * halves of that: what counts as an integration directory, and that a
 * package dropped into the directory by hand is found on the next boot
 * without anybody editing anything.
 *
 * The directory is `<namespace>/<name>`, mirroring the manifest identifier, so
 * "what counts" is now a question about two levels rather than one and the
 * shapes a half-built tree can take are the interesting cases.
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
 *  loader's judgment rather than a fixture that was never going to pass. */
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
  it("returns every namespace's integrations as <namespace>/<name>, sorted", () => {
    const at = scratch();
    for (const d of ["zebra/one", "alpha/two", "alpha/one", "middle/one"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual([
      "alpha/one",
      "alpha/two",
      "middle/one",
      "zebra/one",
    ]);
  });

  // The levels are gathered unsorted and the whole list is sorted once, at
  // the end. That is not the same as sorting each level, and this fixture is
  // where the two disagree: `-` sorts below `/`, so sorting the joined
  // names puts `alpha-two/a` first, while sorting namespaces and then
  // leaves would put `alpha/z` first. Deterministic whatever order the
  // filesystem hands back, which the plain alphabetical case above cannot
  // claim.
  it("sorts the joined names rather than each level", () => {
    const at = scratch();
    for (const d of ["alpha/z", "alpha-two/a"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["alpha-two/a", "alpha/z"]);
  });

  // Two namespaces can each hold the same leaf name, and the namespace is
  // what tells them apart rather than whoever got there first.
  it("keeps two namespaces' same-named integrations apart", () => {
    const at = scratch();
    for (const d of ["acme/podcasts", "marfa/podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual([
      "acme/podcasts",
      "marfa/podcasts",
    ]);
  });

  it("ignores files beside the namespaces", () => {
    const at = scratch();
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    writeFileSync(join(at, "AGENTS.md"), "# not a namespace\n");
    writeFileSync(join(at, "CLAUDE.md"), "# nor is this\n");
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  // A namespace is a directory of integrations, so a file sitting in one
  // names nothing installable. Discovery drops it rather than reporting
  // it: it does not judge candidates, and a loose file is not even a
  // candidate.
  it("ignores files sitting inside a namespace", () => {
    const at = scratch();
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    writeFileSync(join(at, "acme", "README.md"), "# not an integration\n");
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  it("answers nothing for a namespace holding no integrations", () => {
    const at = scratch();
    mkdirSync(join(at, "empty"), { recursive: true });
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  it("answers none for a root whose namespaces are all empty", () => {
    const at = scratch();
    mkdirSync(join(at, "empty"), { recursive: true });
    mkdirSync(join(at, "also-empty"), { recursive: true });
    expect(discoverIntegrationDirs(at)).toEqual([]);
  });

  // Tooling and working directories turn up at the namespace level, so
  // that is a level the rule has to hold at. Reading the directory without
  // it would name `.turbo` as an integration's namespace.
  it("skips scaffolding at the namespace level", () => {
    const at = scratch();
    for (const d of ["_scaffold/src", ".turbo/cache", "marfa/podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["marfa/podcasts"]);
  });

  // The same rule at the leaf, because a namespace can carry scaffolding
  // of its own — a template someone copies, or a directory an editor left.
  it("skips scaffolding at the leaf level too", () => {
    const at = scratch();
    for (const d of ["marfa/_scaffold", "marfa/.turbo", "marfa/podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["marfa/podcasts"]);
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
  // A package a deployment installed, which nothing in this repository
  // names.
  it("is discovered and loaded from the directory alone", async () => {
    const at = scratch();
    installIntegration(at, "someone/thing", manifestFor("someone/thing"));

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/thing"]);
    expect(result.skipped).toEqual([]);
  });

  it("is skipped with a reason when its manifest is invalid, and the rest still load", async () => {
    const at = scratch();
    installIntegration(at, "someone/good", manifestFor("someone/good"));
    installIntegration(at, "someone/broken", null);

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/good"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.dirName).toBe("someone/broken");
    // The reason has to say what was wrong, not merely that something was.
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it("is skipped with a reason when it has no built entry at all", async () => {
    const at = scratch();
    mkdirSync(join(at, "someone", "source-only", "src"), { recursive: true });
    installIntegration(at, "someone/built", manifestFor("someone/built"));

    const result = await loadInTreeManifests({ integrationsRoot: at });
    expect(result.manifests.map((m) => m.name)).toEqual(["someone/built"]);
    expect(result.skipped.map((s) => s.dirName)).toEqual([
      "someone/source-only",
    ]);
  });
});
