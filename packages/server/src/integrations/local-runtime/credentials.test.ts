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
import {
  mintLocalRuntimeCredential,
  DEFAULT_RUNTIME_CREDENTIAL_TTL_MS,
  DISPATCH_JOB_EXPIRY_SECONDS,
} from "./credentials.js";
import { hashApiKey } from "../../middleware/auth.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

/**
 * `direction` describes flow relative to the UPSTREAM service, not access to
 * Marfa. `read` is an INBOUND integration: it pulls from upstream and writes
 * the result into Marfa. Eight of the fourteen in-tree integrations declare
 * it, and every one of them calls `createItem` on its target types, so the
 * default fixture here is `read` — the case that must keep working.
 */
function makeManifest(direction: "read" | "write" | "both" = "read") {
  return {
    name: "test.note-writer",
    version: "0.0.1",
    publisher: "test",
    description: "Ingests notes and nothing else",
    manifest_schema_version: "1.0.0",
    direction,
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
}

const MANIFEST = makeManifest();

async function createIntegrationItem(
  manifest: ReturnType<typeof makeManifest> = MANIFEST,
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        publisher: manifest.publisher,
        manifest,
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

/** Reproduce a row minted before expiry stamping existed: NULL `expires_at`
 *  plus a chosen `created_at`. Raw SQL because the store deliberately refuses
 *  to mint one — that shape can only come from history. */
async function clearExpiryAndBackdate(
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
      `UPDATE api_keys SET created_at = $1, expires_at = NULL WHERE key_hash = $2`,
      [createdAtIso, keyHash],
    );
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun(
      "UPDATE api_keys SET created_at = ?, expires_at = NULL WHERE key_hash = ?",
      [createdAtIso, keyHash],
    );
  }
}

/** Resolve a credential's row id straight from the table. Deliberately not
 *  `keys.validate`: that refuses expired rows, which is exactly the state
 *  several of these tests need to identify. Throws on a miss — a mint that
 *  produced no row is a broken fixture, not a case the assertions carry. */
async function credentialIdByHash(rawKey: string): Promise<string> {
  const keyHash = hashApiKey(rawKey, TEST_API_KEY_SALT);
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  let rows: { id: string }[];
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    rows = (await s.__pgClient("SELECT id FROM api_keys WHERE key_hash = $1", [
      keyHash,
    ])) as { id: string }[];
  } else {
    const s = ctx.storage as unknown as {
      __sqliteAll: (q: string) => Promise<unknown[]>;
    };
    rows = (await s.__sqliteAll(
      `SELECT id FROM api_keys WHERE key_hash = '${keyHash.replace(/'/g, "''")}'`,
    )) as { id: string }[];
  }
  const row = rows[0];
  if (!row) throw new Error("minted credential did not resolve");
  return row.id;
}

describe("mintLocalRuntimeCredential — direction is not an access level", () => {
  // The regression guard for the whole inbound fleet. `direction: "read"`
  // means "reads from upstream", and such an integration exists precisely to
  // write what it pulled into Marfa. Deriving a read-only Marfa grant from it
  // silently kills ingestion: the fetch succeeds, every createItem 403s, the
  // cursor never advances, and the connector reports action_required forever.
  it.each(["read", "write", "both"] as const)(
    "mints write on target types for direction: %s",
    async (direction) => {
      const integrationId = await createIntegrationItem(
        makeManifest(direction),
      );
      const connectionId = await createActiveConnection(integrationId);
      const cred = await mintLocalRuntimeCredential(
        ctx.storage,
        TEST_API_KEY_SALT,
        connectionId,
        "keys",
      );

      const res = await request(ctx.app, "POST", "/items", {
        key: cred.api_key,
        body: { type: "core.note", properties: { body: "ingested" } },
      });
      expect(res.status).toBe(201);
    },
  );
});

describe("mintLocalRuntimeCredential — own-connection read", () => {
  it("reads its own Connection without a system.connection grant", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
    );

    // Handlers resolve properties.configuration this way on every run.
    const res = await request(ctx.app, "GET", `/items/${connectionId}`, {
      key: cred.api_key,
    });
    expect(res.status).toBe(200);
  });

  it("cannot read another Connection", async () => {
    const integrationId = await createIntegrationItem();
    const mine = await createActiveConnection(integrationId);
    const theirs = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      mine,
      "keys",
    );

    // The carve-out is per-item, not a tenant-wide system.connection grant:
    // a sibling connector's configuration stays out of reach.
    const res = await request(ctx.app, "GET", `/items/${theirs}`, {
      key: cred.api_key,
    });
    expect(res.status).toBe(403);
  });
});

describe("mintLocalRuntimeCredential — least privilege", () => {
  it("can write a type the manifest declares", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
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
      "keys",
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
      "keys",
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
      "keys",
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
      "keys",
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
      "keys",
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

  it("revokes a sibling credential that is already past its expiry", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    // Negative TTL mints one that is expired the moment it exists.
    const first = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      -60_000,
    );
    const firstId = await credentialIdByHash(first.api_key);

    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      TTL_MS,
    );

    // The store's get() hides revoked rows, so a null read is the signal.
    expect(await ctx.storage.keys.get(firstId)).toBeNull();
  });

  it("spares a sibling credential that has not expired", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const first = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      TTL_MS,
    );
    const firstId = await credentialIdByHash(first.api_key);

    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      TTL_MS,
    );

    // Unexpired means still usable: the TTL exceeds the dispatch bound, so a
    // live credential always belongs to a dispatch that could still be running.
    expect(await ctx.storage.keys.get(firstId)).not.toBeNull();
  });

  it("revokes a legacy sibling with no expiry once it is older than the TTL", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const first = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      TTL_MS,
    );
    const firstId = await credentialIdByHash(first.api_key);
    // Reproduce a row minted before expiry stamping: no expires_at, aged out.
    await clearExpiryAndBackdate(
      first.api_key,
      new Date(Date.now() - TTL_MS - 60_000).toISOString(),
    );

    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
      TTL_MS,
    );

    expect(await ctx.storage.keys.get(firstId)).toBeNull();
  });
});

describe("runtime credential TTL vs the dispatch bound", () => {
  it("outlives the longest possible dispatch", () => {
    // The invariant that lets expiry be enforced at all. The local substrate
    // cannot refresh a credential mid-run — worker-entry.ts hands the SDK
    // `refreshCredential: () => Promise.resolve(credential)`, the same object,
    // because the handler thread has no storage to mint from. If a credential
    // could expire inside a dispatch, a long backfill would die partway with
    // no recovery path. pg-boss reclaims the job at DISPATCH_JOB_EXPIRY_SECONDS,
    // so the credential must outlast that.
    expect(DEFAULT_RUNTIME_CREDENTIAL_TTL_MS).toBeGreaterThan(
      DISPATCH_JOB_EXPIRY_SECONDS * 1000,
    );
  });
});
