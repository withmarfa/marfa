/**
 * The catalog reconcile: it registers what is absent and leaves what is
 * present exactly alone.
 *
 * The second half is the safety property. A connection resolves the
 * manifest frozen on its catalog row, so a reconcile that rewrote a row in
 * place would change an installed connection's declared surface with
 * nobody told, which is the defect this whole area exists to close rather
 * than a shortcut to it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { reconcileIntegrationCatalog } from "./catalog-reconcile.js";
import { findCatalogRow } from "./register-manifest.js";
import type { InTreeManifest } from "./load-manifests.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

let seq = 0;
function makeManifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  seq += 1;
  return {
    name: `acme/reconcile-${String(seq)}`,
    version: "1.0.0",
    publisher: "acme",
    description: "catalog reconcile test",
    direction: "read",
    runs_on: "server" as const,
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
    manifest_schema_version: "2.0.0",
    ...overrides,
  };
}

function entry(manifest: IntegrationManifest): InTreeManifest {
  return {
    name: manifest.name,
    // The directory mirrors the identifier, so the two are one string.
    dirName: manifest.name,
    manifest,
  };
}

describe("reconcileIntegrationCatalog", () => {
  it("registers a manifest the catalog does not carry", async () => {
    const m = makeManifest();
    const result = await reconcileIntegrationCatalog(ctx.storage, [entry(m)]);

    expect(result.skippedLocked).toBe(false);
    expect(result.registered).toEqual([{ name: m.name, version: "1.0.0" }]);
    expect(result.failed).toEqual([]);

    const row = await findCatalogRow(ctx.storage, m.name, "1.0.0", undefined);
    expect(row).toBeDefined();
    expect(
      (row?.properties as { manifest: IntegrationManifest }).manifest.name,
    ).toBe(m.name);
  });

  it("is idempotent: a second run registers nothing and reports the row present", async () => {
    const m = makeManifest();
    await reconcileIntegrationCatalog(ctx.storage, [entry(m)]);
    const second = await reconcileIntegrationCatalog(ctx.storage, [entry(m)]);

    expect(second.registered).toEqual([]);
    expect(second.alreadyPresent).toEqual([{ name: m.name, version: "1.0.0" }]);
  });

  it("never rewrites an existing row, even when the build's manifest differs at the same version", async () => {
    const original = makeManifest({ target_types: ["core.note"] });
    await reconcileIntegrationCatalog(ctx.storage, [entry(original)]);
    const before = await findCatalogRow(
      ctx.storage,
      original.name,
      "1.0.0",
      undefined,
    );

    // Same name, same version, different declared surface. This is the
    // shape the merge guard refuses, so it should not occur — and if it
    // does, the reconcile must not resolve it by moving an installed
    // connection's surface underneath it.
    const drifted = makeManifest({
      name: original.name,
      version: "1.0.0",
      target_types: ["core.bookmark"],
    });
    const result = await reconcileIntegrationCatalog(ctx.storage, [
      entry(drifted),
    ]);

    expect(result.registered).toEqual([]);
    expect(result.alreadyPresent).toHaveLength(1);

    const after = await findCatalogRow(
      ctx.storage,
      original.name,
      "1.0.0",
      undefined,
    );
    expect(
      (after?.properties as { manifest: IntegrationManifest }).manifest
        .target_types,
    ).toEqual(["core.note"]);
    expect(after?.id).toBe(before?.id);
  });

  it("registers a newer version as a sibling, leaving the old row addressed", async () => {
    const v1 = makeManifest();
    await reconcileIntegrationCatalog(ctx.storage, [entry(v1)]);
    const v2 = makeManifest({
      name: v1.name,
      version: "2.0.0",
      target_types: ["core.bookmark"],
    });
    await reconcileIntegrationCatalog(ctx.storage, [entry(v2)]);

    const oldRow = await findCatalogRow(
      ctx.storage,
      v1.name,
      "1.0.0",
      undefined,
    );
    const newRow = await findCatalogRow(
      ctx.storage,
      v1.name,
      "2.0.0",
      undefined,
    );
    expect(oldRow).toBeDefined();
    expect(newRow).toBeDefined();
    expect(oldRow?.id).not.toBe(newRow?.id);
  });

  it("carries on past a manifest that cannot register, and names it", async () => {
    const bad = makeManifest({ target_types: ["nope.not_a_type"] });
    const good = makeManifest();
    const result = await reconcileIntegrationCatalog(ctx.storage, [
      entry(bad),
      entry(good),
    ]);

    expect(result.registered).toEqual([{ name: good.name, version: "1.0.0" }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe(bad.name);
    expect(result.failed[0]?.reason).toContain("nope.not_a_type");
  });
});
