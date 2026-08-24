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
import { CLIENT_MANIFESTS } from "./client-manifests.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

/**
 * The lock covers the client manifests and nothing else.
 *
 * An installed integration's manifest arrives from withmarfa/integrations
 * at whatever commit the image pinned, so this build cannot read one and
 * has nothing to hold to a lock. A client's ships with the build, is
 * exposed to exactly the defect the lock exists for — content moving while
 * the version stands still — and is reachable from a constant, so it needs
 * no directory and nothing here is conditional.
 */
describe("the shipped manifests against the committed lock", () => {
  it("has a lock file", () => {
    expect(existsSync(LOCK_PATH)).toBe(true);
  });

  it("matches, or names exactly what to do about it", () => {
    const committed = JSON.parse(
      readFileSync(LOCK_PATH, "utf8"),
    ) as ManifestLock;
    // An empty list compares clean against an empty lock, which is the
    // silence this whole file exists against.
    expect(CLIENT_MANIFESTS.length).toBeGreaterThan(0);
    const violations = compareToLock(
      buildManifestLock(CLIENT_MANIFESTS),
      committed,
    );
    expect(violations.map(describeViolation)).toEqual([]);
  });
});
