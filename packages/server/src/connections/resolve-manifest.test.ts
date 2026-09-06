/**
 * Tests for the integration_ref-based manifest resolution helper.
 *
 * The helper resolves only via the connection's
 * `integration_ref` → `system.integration` item. Missing or
 * unresolvable refs surface as `MISSING_REQUIRED_FIELD`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { resolveConnectionManifest } from "./resolve-manifest.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeManifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  return {
    name: "acme/resolve-test",
    version: "1.0.0",
    publisher: "acme",
    description: "manifest resolution test",
    direction: "read",
    runs_on: "server" as const,
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    ...overrides,
  };
}

async function createConnection(integrationRef?: string): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
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
        manifest: manifest,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

describe("resolveConnectionManifest", () => {
  it("resolves the manifest from a connection's integration_ref", async () => {
    const integrationId = await createIntegration();
    const connectionId = await createConnection(integrationId);

    const result = await resolveConnectionManifest(
      ctx.storage,
      connectionId,
      undefined,
    );
    expect(result.integration_item_id).toBe(integrationId);
    expect(result.manifest.name).toBe("acme/resolve-test");
  });

  it("throws NOT_FOUND on unknown connection id", async () => {
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(
        ctx.storage,
        "itm_no_such_connection",
        undefined,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarfaError);
    expect((thrown as MarfaError).code).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws MISSING_REQUIRED_FIELD when the connection has no integration_ref", async () => {
    const connectionId = await createConnection(undefined);
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(ctx.storage, connectionId, undefined);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarfaError);
    expect((thrown as MarfaError).code).toBe(ErrorCode.MISSING_REQUIRED_FIELD);
  });

  it("throws MISSING_REQUIRED_FIELD when integration_ref doesn't resolve", async () => {
    const connectionId = await createConnection("itm_does_not_exist");
    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(ctx.storage, connectionId, undefined);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarfaError);
    expect((thrown as MarfaError).code).toBe(ErrorCode.MISSING_REQUIRED_FIELD);
  });

  it("throws VALIDATION_ERROR when persisted manifest is invalid", async () => {
    // Plant a system.integration item whose manifest blob is structurally
    // bad — simulates a future manifest_schema major bump that retired
    // this item's contract.
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme/invalid-persisted",
          manifest_version: "1.0.0",
          publisher: "acme",
          direction: "read",
          manifest: { name: "broken", version: "missing fields" },
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const connectionId = await createConnection(integration.id);

    let thrown: unknown = null;
    try {
      await resolveConnectionManifest(ctx.storage, connectionId, undefined);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarfaError);
    expect((thrown as MarfaError).code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
