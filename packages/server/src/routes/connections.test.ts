/**
 * Tests for `POST /connections/:id/uninstall`. The pipeline-level mechanics
 * are covered by `connections/uninstall-pipeline.test.ts`; this file
 * pins the route-layer behaviour: auth gating, error mapping (UninstallError
 * → 400/404), and the JSON response shape the SDK consumes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "../connections/install-pipeline.js";
import type { IntegrationManifest } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

function manifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "uninstall route test",
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
  connectionId: string;
  credentialId: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const integrationName = `acme.uninstall-route-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: integrationName,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest: manifest(integrationName) as unknown as Record<
          string,
          unknown
        >,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, "test-salt", {
    apiKeyId: adminKey.id,
    tenantId: undefined,
    integrationItemId: integration.id,
    manifest: manifest(integrationName),
    label: integrationName,
  });

  return {
    connectionId: result.connection_id,
    credentialId: result.credential_id,
  };
}

interface UninstallResponse {
  connection_id: string;
  revoked_credential_ids: string[];
  oauth_tokens_deleted: boolean;
  leased_tokens_revoked: number;
  inbound_webhooks_disabled: number;
  activity_id: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe("POST /connections/:id/uninstall — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const installed = await installFresh();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-admin (member) callers with 403", async () => {
    const installed = await installFresh();
    const memberKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "uninstall-member",
        source: `uninstall-member-${Date.now().toString()}`,
        role: "member",
      },
    });
    const memberKey = ((await memberKeyRes.json()) as { key: string }).key;

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: memberKey },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/:id/uninstall — happy path", () => {
  it("returns 200 with the cleanup-counts shape and revokes the credential", async () => {
    const installed = await installFresh();

    const res = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as UninstallResponse;

    expect(body.connection_id).toBe(installed.connectionId);
    expect(body.revoked_credential_ids).toEqual([installed.credentialId]);
    expect(body.oauth_tokens_deleted).toBe(false);
    expect(body.leased_tokens_revoked).toBe(0);
    expect(body.inbound_webhooks_disabled).toBe(0);
    expect(body.activity_id).toMatch(/^[0-9a-f-]+$/);

    // Credential really gone from active list.
    const credAfter = (await ctx.storage.keys.list()).find(
      (k) => k.id === installed.credentialId,
    );
    expect(credAfter).toBeUndefined();

    // State is revoked.
    const conn = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(conn?.state).toBe("revoked");
  });
});

describe("POST /connections/:id/uninstall — error mapping", () => {
  it("returns 404 for an unknown connection id", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/connections/00000000-0000-7000-8000-000000000000/uninstall",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("not_found");
  });

  it("returns 400 with uninstall_error_code=already_revoked on second call", async () => {
    const installed = await installFresh();

    const first = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(first.status).toBe(200);

    const second = await request(
      ctx.app,
      "POST",
      `/connections/${installed.connectionId}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as ErrorBody & {
      error: { details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.uninstall_error_code).toBe("already_revoked");
  });

  it("returns 400 with uninstall_error_code=wrong_connection_kind for a user-app-grant", async () => {
    const grant = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "user-app-grant",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${grant.id}/uninstall`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody & {
      error: { details?: Record<string, unknown> };
    };
    expect(body.error.details?.uninstall_error_code).toBe(
      "wrong_connection_kind",
    );
  });
});
