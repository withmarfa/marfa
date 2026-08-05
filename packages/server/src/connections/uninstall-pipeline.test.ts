/**
 * Direct tests of the uninstall pipeline. The HTTP-level happy path is
 * covered by routes/connections.test.ts; these tests exercise the
 * pipeline against a real test storage so the cleanup-of-each-artifact
 * branches run end-to-end (runtime credential revocation, OAuth-token
 * deletion, leased-token revocation, inbound-webhook disable, state
 * transition, activity emission, audit log).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "./install-pipeline.js";
import { performUninstall, UninstallError } from "./uninstall-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(): IntegrationManifest {
  return {
    name: "acme.uninstall-direct",
    version: "1.0.0",
    publisher: "Acme",
    description: "uninstall test",
    direction: "both",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

async function installFresh(): Promise<{
  apiKeyId: string;
  connectionId: string;
  credentialId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: `acme.uninstall-direct-${Date.now().toString()}`,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest: manifest(),
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, "test-salt", {
    apiKeyId: adminKey.id,
    spaceId: undefined,
    authMode: "keys",
    integrationItemId: integration.id,
    manifest: {
      ...manifest(),
      name: `acme.uninstall-${Date.now().toString()}`,
    },
    label: `direct uninstall test ${Date.now().toString()}`,
  });

  return {
    apiKeyId: adminKey.id,
    connectionId: result.connection_id,
    credentialId: result.credential_id,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("performUninstall — happy path", () => {
  it("revokes the runtime credential, transitions the connection to revoked, emits activity, audits", async () => {
    const installed = await installFresh();

    const credBefore = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credBefore).toBeTruthy();

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    expect(result.connection_id).toBe(installed.connectionId);
    expect(result.revoked_credential_ids).toEqual([installed.credentialId]);
    expect(result.oauth_tokens_deleted).toBe(false);
    expect(result.leased_tokens_revoked).toBe(0);
    expect(result.inbound_webhooks_disabled).toBe(0);
    expect(result.activity_id).toMatch(/^[0-9a-f-]+$/);

    // Credential is gone from active list (revoked_at stamped → list filters it out).
    const credAfter = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credAfter).toBeUndefined();

    // Connection state flipped to revoked — and so did the properties
    // that describe the same fact.
    //
    // Asserting `state` alone is why this shipped a row reading
    // `state: revoked` beside `status: active`. The type documents
    // `status` as the lifecycle status and its enum is exactly
    // `active | revoked`, so the two cannot legitimately disagree. The
    // shape is asserted whole rather than field by field for that reason.
    const conn = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(conn?.state).toBe("revoked");
    expect(conn?.properties.status).toBe("revoked");
    // Stamped rather than cleared: a property cannot be removed through
    // the update path (shallow merge, and an explicit null on an optional
    // field means "leave unset"), which is exactly how `healthy` survived
    // an uninstall. The enum gained a `revoked` member so the field can
    // say the runtime is gone instead of reporting stale health.
    expect(conn?.properties.runtime_status).toBe("revoked");

    // Activity row was emitted with the right summary + provenance.
    const activity = await ctx.storage.items.get(result.activity_id, undefined);
    expect(activity?.type).toBe("system.activity");
    expect(activity?.properties.summary).toMatch(/Uninstalled connection /);
    expect(activity?.properties.connection_id).toBe(installed.connectionId);

    // Audit row written.
    const auditRows = await ctx.storage.audit.list({
      action: "integration.uninstall",
      resource_id: installed.connectionId,
      limit: 5,
    });
    expect(auditRows.data.length).toBeGreaterThanOrEqual(1);
    const last = auditRows.data[0];
    expect(last?.details.revoked_credential_ids).toEqual([
      installed.credentialId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("performUninstall — error paths", () => {
  it("throws UninstallError(connection_not_found) for an unknown id", async () => {
    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: "anything",
        spaceId: undefined,
        connectionId: "00000000-0000-7000-8000-000000000000",
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "connection_not_found",
    });
  });

  it("throws UninstallError(wrong_connection_kind) when called against a non-integration connection", async () => {
    // Mint a system.connection with kind: app (the OAuth-grant
    // shape) and confirm uninstall rejects it. Uninstall is scoped to
    // integration kinds.
    const grant = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );

    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: "anything",
        spaceId: undefined,
        connectionId: grant.id,
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "wrong_connection_kind",
    });
  });

  it("throws UninstallError(already_revoked) on second call against the same connection", async () => {
    const installed = await installFresh();

    await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    await expect(
      performUninstall(ctx.storage, {
        apiKeyId: installed.apiKeyId,
        spaceId: undefined,
        connectionId: installed.connectionId,
      }),
    ).rejects.toMatchObject({
      name: "UninstallError",
      code: "already_revoked",
    });
  });

  it("UninstallError carries the discriminator code so callers can branch", () => {
    // Stable shape contract — the route layer keys on `code` to map to
    // 400 vs 404.
    const err = new UninstallError("connection_not_found", "x");
    expect(err.code).toBe("connection_not_found");
    expect(err.name).toBe("UninstallError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Idempotency-at-the-artifact-layer (uninstall is monotonic, no compensations)
// ---------------------------------------------------------------------------

describe("performUninstall — partial-state semantics", () => {
  it("revokes multiple runtime credentials when the connection accumulated more than one", async () => {
    // Operationally a runtime credential is 1:1 with a connection, but
    // the schema doesn't enforce uniqueness. The pipeline must revoke
    // every active credential bound to the connection — defense in depth.
    const installed = await installFresh();

    // Mint a second runtime credential bound to the same connection.
    const { hashApiKey } = await import("../middleware/auth.js");
    const extraCred = await ctx.storage.keys.createRuntimeCredential(
      {
        label: "extra runtime cred",
        source: `integration-extra:${installed.connectionId}`,
        role: "member",
        type_permissions: { "core.note": "read" },
        connection_id: installed.connectionId,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: runtimeCredentialItemSource({ name: "acme.fixture" }),
      },
      hashApiKey("marfa_k1_" + "0".repeat(64), "test-salt"),
      undefined,
    );

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      spaceId: undefined,
      connectionId: installed.connectionId,
    });

    expect(result.revoked_credential_ids).toEqual(
      expect.arrayContaining([installed.credentialId, extraCred.id]),
    );
    expect(result.revoked_credential_ids.length).toBe(2);
  });
});
