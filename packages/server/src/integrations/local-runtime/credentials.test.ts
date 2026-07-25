/**
 * Lifecycle guarantees for locally minted runtime credentials.
 *
 * Three invariants, each one a regression guard:
 *
 *   1. Least privilege — a credential minted for a Connection can only
 *      write the types its Integration manifest declares. A manifest
 *      that targets `core.note` must not produce a credential that can
 *      write `core.task`.
 *   2. Expiry is enforced — a runtime credential past its `expires_at`
 *      is refused at the bearer gate exactly like a revoked key.
 *   3. Supersede revokes — minting a fresh credential revokes the
 *      connection's older runtime credentials once they are past
 *      TTL + one-TTL grace, so per-dispatch mints don't accumulate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { mintLocalRuntimeCredential } from "./credentials.js";
import { hashApiKey } from "../../middleware/auth.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

const MANIFEST = {
  name: "test.note-writer",
  version: "0.0.1",
  publisher: "test",
  description: "Writes notes and nothing else",
  manifest_schema_version: "1.0.0",
  direction: "write" as const,
  runtime_compatibility: ["local"] as const,
  target_types: ["core.note"] as const,
  triggers: [{ type: "schedule" as const, config: { cron: "*/5 * * * *" } }],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {} as Record<string, never>,
  webhook_verification: { method: "hmac-sha256" as const },
  permissions: {
    extension: { "connection.runtime": "write" as const },
    edge: {},
  },
};

async function createIntegrationItem(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: MANIFEST.name,
        manifest_version: MANIFEST.version,
        publisher: MANIFEST.publisher,
        manifest: MANIFEST,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function createActiveConnection(
  integrationItemId?: string,
): Promise<string> {
  const properties: Record<string, unknown> = {
    kind: "integration",
    status: "active",
    granted_at: new Date().toISOString(),
  };
  if (integrationItemId) properties.integration_ref = integrationItemId;
  const item = await ctx.storage.items.create(
    { type: "system.connection", properties },
    undefined,
  );
  return item.id;
}

/** Rewrite a credential row's `created_at` so age-based lifecycle logic
 *  can be exercised without waiting. Raw SQL because the store never
 *  exposes a way to backdate — that's the point. */
async function backdateCredentialByHash(
  rawKey: string,
  createdAtIso: string,
): Promise<void> {
  const keyHash = hashApiKey(rawKey, TEST_API_KEY_SALT);
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(
      `UPDATE api_keys SET created_at = $1 WHERE key_hash = $2`,
      [createdAtIso, keyHash],
    );
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun(
      "UPDATE api_keys SET created_at = ? WHERE key_hash = ?",
      [createdAtIso, keyHash],
    );
  }
}

/** Resolve a freshly minted credential's row id. Throws rather than
 *  returning null: a mint that produced no readable row is a broken
 *  fixture, not a case the assertions below should have to carry. */
async function credentialIdByHash(rawKey: string): Promise<string> {
  const keyHash = hashApiKey(rawKey, TEST_API_KEY_SALT);
  const stored = await ctx.storage.keys.validate(keyHash);
  if (!stored) throw new Error("minted credential did not resolve");
  return stored.id;
}

describe("mintLocalRuntimeCredential — least privilege", () => {
  it("can write a type the manifest declares", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: { type: "core.note", properties: { body: "in scope" } },
    });
    expect(res.status).toBe(201);
  });

  it("cannot write a type the manifest does not declare", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    // MANIFEST targets only core.note — a core.task write must be refused.
    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: { type: "core.task", properties: { title: "out of scope" } },
    });
    expect(res.status).toBe(403);
  });

  it("still reports activity — the status channel is substrate contract, not manifest surface", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    // MANIFEST declares neither system.activity nor system.connection;
    // the runtime SDK needs both on every run regardless.
    const activityRes = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: {
        type: "system.activity",
        properties: {
          severity: "info",
          summary: "Sync run completed",
          connection_id: connectionId,
        },
      },
    });
    expect(activityRes.status).toBe(201);

    const connectionRes = await request(
      ctx.app,
      "GET",
      `/items/${connectionId}`,
      { key: cred.api_key },
    );
    expect(connectionRes.status).toBe(200);
  });

  it("grants no manifest type reach when the connection has no manifest", async () => {
    const connectionId = await createActiveConnection();
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: { type: "core.note", properties: { body: "no manifest" } },
    });
    expect(res.status).toBe(403);
  });
});

describe("mintLocalRuntimeCredential — expiry enforcement", () => {
  it("refuses a credential past its expires_at at the bearer gate", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    // Negative TTL mints a credential that is already expired on the
    // wire — the row must be refused exactly like a revoked key.
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      -60_000,
    );
    expect(new Date(cred.expires_at).getTime()).toBeLessThan(Date.now());

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: { type: "core.note", properties: { body: "expired" } },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a credential still inside its TTL", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: cred.api_key,
      body: { type: "core.note", properties: { body: "fresh" } },
    });
    expect(res.status).toBe(201);
  });
});

describe("mintLocalRuntimeCredential — revoke on supersede", () => {
  const TTL_MS = 600_000;

  it("revokes older credentials past TTL + one-TTL grace", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const first = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      TTL_MS,
    );
    const firstId = await credentialIdByHash(first.api_key);

    // Age the first credential past TTL + grace (2 x TTL), then mint again.
    await backdateCredentialByHash(
      first.api_key,
      new Date(Date.now() - 2 * TTL_MS - 60_000).toISOString(),
    );
    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      TTL_MS,
    );

    // The superseded credential is revoked — the store's get() hides
    // revoked rows, so a null read is the revocation signal.
    expect(await ctx.storage.keys.get(firstId)).toBeNull();
  });

  it("spares credentials still inside the grace window", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const first = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      TTL_MS,
    );
    const firstId = await credentialIdByHash(first.api_key);

    // Aged past its own TTL but still inside the one-TTL grace — an
    // in-flight dispatch could still be holding it.
    await backdateCredentialByHash(
      first.api_key,
      new Date(Date.now() - TTL_MS - 60_000).toISOString(),
    );
    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      TTL_MS,
    );

    expect(await ctx.storage.keys.get(firstId)).not.toBeNull();
  });
});
