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
  // where the two disagree: `-` sorts below `/`, so sorting the joined names
  // puts `alpha-two/a` first, while sorting handles and then leaves would put
  // `alpha/z` first. Deterministic whatever order the filesystem hands back,
  // which the plain alphabetical case above cannot claim.
  it("sorts the joined names rather than each level", () => {
    const at = scratch();
    for (const d of ["alpha/z", "alpha-two/a"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["alpha-two/a", "alpha/z"]);
  });

  // The collision the flat layout could not express: two publishers each
  // shipping the same leaf name, told apart by the handle rather than by
  // whoever got there first.
  it("keeps two publishers' same-named integrations apart", () => {
    const at = scratch();
    for (const d of ["acme/podcasts", "marfa/podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual([
      "acme/podcasts",
      "marfa/podcasts",
    ]);
  });

  it("ignores files beside the handles", () => {
    const at = scratch();
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    writeFileSync(join(at, "AGENTS.md"), "# not a handle\n");
    writeFileSync(join(at, "CLAUDE.md"), "# nor is this\n");
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  // A handle is a directory of integrations, so a file sitting in one names
  // nothing installable. Discovery drops it rather than reporting it: it
  // does not judge candidates, and a loose file is not even a candidate.
  it("ignores files sitting inside a handle", () => {
    const at = scratch();
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    writeFileSync(join(at, "acme", "README.md"), "# not an integration\n");
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  it("answers nothing for a handle holding no integrations", () => {
    const at = scratch();
    mkdirSync(join(at, "empty"), { recursive: true });
    mkdirSync(join(at, "acme", "real"), { recursive: true });
    expect(discoverIntegrationDirs(at)).toEqual(["acme/real"]);
  });

  it("answers none for a root whose handles are all empty", () => {
    const at = scratch();
    mkdirSync(join(at, "empty"), { recursive: true });
    mkdirSync(join(at, "also-empty"), { recursive: true });
    expect(discoverIntegrationDirs(at)).toEqual([]);
  });

  // The scaffold shipped as a dispatchable integration on every deployment
  // under the old arrangement, because the runtime loader prepended it by
  // hand. Reading the directory naively would have promoted it further, into
  // the installable catalog. It sits at the handle level, so that is the
  // level that has to hold the rule.
  it("skips scaffolding at the handle level, which is what keeps _template out", () => {
    const at = scratch();
    for (const d of ["_template/src", ".turbo/cache", "marfa/podcasts"]) {
      mkdirSync(join(at, d), { recursive: true });
    }
    expect(discoverIntegrationDirs(at)).toEqual(["marfa/podcasts"]);
  });

  // The same rule at the leaf, because a handle can carry scaffolding of its
  // own — a template a publisher copies, or a directory an editor left.
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
  // The whole point of the change: this is a package a deployment installed,
  // which no array in this repository has ever mentioned.
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
