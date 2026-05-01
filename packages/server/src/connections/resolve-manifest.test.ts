/**
 * Tests for the integration_ref-based manifest resolution helper —
 * Layer 2 PR 2.
 *
 * Covers all four resolution paths:
 *   - integration_ref set + resolves + valid → preferred path
 *   - integration_ref set + resolves + invalid manifest → throws
 *   - integration_ref set + doesn't resolve → falls through to inline
 *   - no integration_ref + inline supplied → legacy path
 *   - no integration_ref + no inline → MISSING_REQUIRED_FIELD
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { resolveConnectionManifest } from "./resolve-manifest.js";
import type { IntegrationManifest } from "@mymehq/shared";
import { MymeError, ErrorCode } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

function makeManifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  return {
    name: "acme.resolve-test",
    version: "1.0.0",
    publisher: "Acme",
    description: "manifest resolution test",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
    ...overrides,
  };
}

async function createConnection(integrationRef?: string): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "external-service-connector",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integrationRef,
      },
    },
    undefined,
  );
  return item.id;
}

async function createIntegration(
  manifest: IntegrationManifest = makeManifest(),
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        publisher: manifest.publisher,
        direction: manifest.direction,
        runtime_compatibility: manifest.runtime_compatibility,
        manifest: manifest as unknown as Record<string, unknown>,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

describe("resolveConnectionManifest", () => {
  it("preferred path: integration_ref resolves to a system.integration item", async () => {
    const integrationId = await createIntegration();
    const connectionId = await createConnection(integrationId);

    const result = await resolveConnectionManifest(
      ctx.storage,
      connectionId,
      undefined,
      undefined,
    );
    expect(result.source).toBe("integration_ref");
    expect(result.integration_item_id).toBe(integrationId);
    expect(result.manifest.name).toBe("acme.resolve-test");
  });

  it("preferred path takes precedence over inline manifest in body", async () => {
    const persisted = makeManifest({ name: "acme.persisted" });
    const inline = makeManifest({ name: "acme.inline-overridden" });
    const integrationId = await createIntegration(persisted);
    const connectionId = await createConnection(integrationId);

    const result = await resolveConnectionManifest(
      ctx.storage,
      connectionId,
      undefined,
      inline,
    );
    expect(result.source).toBe("integration_ref");
    expect(result.manifest.name).toBe("acme.persisted");
  });

  it("legacy fallback: no integration_ref + inline manifest supplied", async () => {
    const connectionId = await createConnection(undefined);
    const inline = makeManifest({ name: "acme.legacy-inline" });

    const result = await resolveConnectionManifest(
      ctx.storage,
      connectionId,
      undefined,
      inline,
    );
    expect(result.source).toBe("inline_legacy");
    expect(result.integration_item_id).toBeNull();
    expect(result.manifest.name).toBe("acme.legacy-inline");
  });

  it("orphan integration_ref falls through to inline when target item missing", async () => {
    const inline = makeManifest({ name: "acme.orphan-fallback" });
    const connectionId = await createConnection("itm_does_not_exist");

    const result = await resolveConnectionManifest(
      ctx.storage,
      connectionId,
      undefined,
      inline,
    );
    expect(result.source).toBe("inline_legacy");
    expect(result.manifest.name).toBe("acme.orphan-fallback");
  });

  it("throws NOT_FOUND on unknown connection id", async () => {
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(
        ctx.storage,
        "itm_no_such_connection",
        undefined,
        makeManifest(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MymeError);
    expect((thrown as MymeError).code).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws MISSING_REQUIRED_FIELD when neither path resolves", async () => {
    const connectionId = await createConnection(undefined);
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(
        ctx.storage,
        connectionId,
        undefined,
        undefined,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MymeError);
    expect((thrown as MymeError).code).toBe(ErrorCode.MISSING_REQUIRED_FIELD);
  });

  it("throws VALIDATION_ERROR when persisted manifest is invalid", async () => {
    // Plant a system.integration item whose manifest blob is structurally
    // bad — simulates a future manifest_schema major bump that retired
    // this item's contract.
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.invalid-persisted",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "read",
          runtime_compatibility: ["hosted"],
          manifest: { name: "broken", version: "missing fields" },
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const connectionId = await createConnection(integration.id);

    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(
        ctx.storage,
        connectionId,
        undefined,
        makeManifest(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MymeError);
    expect((thrown as MymeError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("throws VALIDATION_ERROR when legacy inline manifest is invalid", async () => {
    const connectionId = await createConnection(undefined);
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(ctx.storage, connectionId, undefined, {
        name: "broken",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MymeError);
    expect((thrown as MymeError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
