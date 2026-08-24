/**
 * The manifest lock's own tests, plus the check that gates a merge.
 *
 * The gating test lives here, in the ordinary suite, rather than in a
 * generated-artifact freshness workflow. Those workflows are excluded from
 * pull-request events, so the only pre-merge guard on them is a manual
 * dispatch somebody has to remember to read; `main` has gone red after a
 * merge whose dispatch had already failed unread. A plain test cannot be
 * merged past.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationManifest } from "@withmarfa/shared";
import {
  buildManifestLock,
  compareToLock,
  describeViolation,
  hashManifestDeclaration,
  type ManifestLock,
} from "./manifest-lock.js";
import { loadInTreeManifests } from "./load-manifests.js";
import { CLIENT_MANIFESTS } from "./client-manifests.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INTEGRATIONS_ROOT = resolve(SERVER_ROOT, "../../integrations");
const LOCK_PATH = resolve(SERVER_ROOT, "manifest-lock.json");

function manifest(
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest {
  return {
    name: "acme/thing",
    version: "1.0.0",
    manifest_schema_version: "2.0.0",
    publisher: "acme",
    description: "A thing.",
    direction: "read",
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...over,
  };
}

describe("hashManifestDeclaration", () => {
  it("ignores the version, so a bump alone does not change the hash", () => {
    expect(hashManifestDeclaration(manifest({ version: "1.0.0" }))).toBe(
      hashManifestDeclaration(manifest({ version: "2.0.0" })),
    );
  });

  it("ignores key order, so a formatter is not a declaration change", () => {
    const a = manifest();
    // Rebuild with the keys inserted in a different order. Insertion order
    // is what `JSON.stringify` follows, so this is the reordering a
    // formatter or a hand edit actually produces.
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(a).sort().reverse()) {
      reordered[key] = (a as unknown as Record<string, unknown>)[key];
    }
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(
      hashManifestDeclaration(reordered as unknown as IntegrationManifest),
    ).toBe(hashManifestDeclaration(a));
  });

  it("changes when the declared surface changes", () => {
    expect(
      hashManifestDeclaration(manifest({ target_types: ["core.bookmark"] })),
    ).not.toBe(hashManifestDeclaration(manifest()));
  });

  it("changes when a capability flag is added, which is the case that bit", () => {
    expect(
      hashManifestDeclaration(manifest({ supports_user_mappings: true })),
    ).not.toBe(hashManifestDeclaration(manifest()));
  });
});

describe("compareToLock", () => {
  it("passes when the build matches the lock", () => {
    const built = buildManifestLock([{ manifest: manifest() }]);
    expect(compareToLock(built, built)).toEqual([]);
  });

  it("catches content changing while the version stands still", () => {
    const committed = buildManifestLock([{ manifest: manifest() }]);
    const built = buildManifestLock([
      { manifest: manifest({ target_types: ["core.bookmark"] }) },
    ]);
    expect(compareToLock(built, committed)).toEqual([
      {
        kind: "content_changed_without_version",
        name: "acme/thing",
        version: "1.0.0",
      },
    ]);
  });

  it("catches a version moving with nothing behind it", () => {
    const committed = buildManifestLock([{ manifest: manifest() }]);
    const built = buildManifestLock([
      { manifest: manifest({ version: "1.1.0" }) },
    ]);
    expect(compareToLock(built, committed)).toEqual([
      {
        kind: "version_moved_without_content",
        name: "acme/thing",
        from: "1.0.0",
        to: "1.1.0",
      },
    ]);
  });

  it("accepts a real change carried by a version bump", () => {
    const committed = buildManifestLock([{ manifest: manifest() }]);
    const built = buildManifestLock([
      {
        manifest: manifest({
          version: "1.1.0",
          target_types: ["core.bookmark"],
        }),
      },
    ]);
    expect(compareToLock(built, committed)).toEqual([]);
  });

  it("notices a new integration and a removed one", () => {
    const committed = buildManifestLock([{ manifest: manifest() }]);
    const built = buildManifestLock([
      { manifest: manifest({ name: "acme/other" }) },
    ]);
    expect(
      compareToLock(built, committed)
        .map((v) => v.kind)
        .sort(),
    ).toEqual(["missing_from_build", "missing_from_lock"]);
  });
});

describe("the shipped manifests against the committed lock", () => {
  it("has a lock file", () => {
    expect(existsSync(LOCK_PATH)).toBe(true);
  });

  it("matches, or names exactly what to do about it", async () => {
    const { manifests } = await loadInTreeManifests({
      integrationsRoot: INTEGRATIONS_ROOT,
    });
    // Gated on the discovered half alone. Nothing built means `pnpm build`
    // has not run in this tree, and the check cannot say anything either
    // way; the client manifests ship with the build and so are present even
    // then, which would turn an unbuilt tree into fourteen bogus
    // `missing_from_build` violations.
    if (manifests.length === 0) return;

    const committed = JSON.parse(
      readFileSync(LOCK_PATH, "utf8"),
    ) as ManifestLock;
    const violations = compareToLock(
      buildManifestLock([...manifests, ...CLIENT_MANIFESTS]),
      committed,
    );
    expect(violations.map(describeViolation)).toEqual([]);
  });

  it("carries every client manifest", () => {
    // The lock's whole job is catching a manifest whose content moved
    // without its version. A client manifest reaches the catalog by a
    // different route and is exposed to exactly the same defect, so a lock
    // built from the directory alone would guard fourteen of fifteen.
    //
    // Deliberately unguarded. The sibling above returns early on an unbuilt
    // tree because it has nothing to compare; this one needs only a file on
    // disk and a constant, and guarding it on discovery would make the one
    // check whose whole subject is the half discovery cannot see pass
    // having asserted nothing.
    const committed = JSON.parse(
      readFileSync(LOCK_PATH, "utf8"),
    ) as ManifestLock;
    // A loop over an empty list asserts nothing, which is the same silence
    // in a smaller place.
    expect(CLIENT_MANIFESTS.length).toBeGreaterThan(0);
    for (const client of CLIENT_MANIFESTS) {
      expect(Object.keys(committed)).toContain(client.manifest.name);
    }
  });

  it("could not have got them from the directory", async () => {
    // The other half of the claim, and the half that does need a built
    // tree: what discovery yields on its own has no client in it, so the
    // entries above can only have come from the build.
    const { manifests } = await loadInTreeManifests({
      integrationsRoot: INTEGRATIONS_ROOT,
    });
    if (manifests.length === 0) return;

    const discoveredOnly = buildManifestLock(manifests);
    for (const client of CLIENT_MANIFESTS) {
      expect(Object.keys(discoveredOnly)).not.toContain(client.manifest.name);
    }
  });
});
