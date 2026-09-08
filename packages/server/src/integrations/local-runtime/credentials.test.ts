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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * the result into Marfa. Most integrations declare it, and every one of
 * them calls `createItem` on its target types, so the default fixture here
 * is `read` — the case that must keep working.
 */
function makeManifest(direction: "read" | "write" | "both" = "read") {
  return {
    name: "test/note-writer",
    version: "0.0.1",
    publisher: "test",
    description: "Ingests notes and nothing else",
    manifest_schema_version: "2.0.0",
    direction,
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
  // cursor never advances, and the integration reports action_required forever.
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

describe("mintLocalRuntimeCredential — the ceiling on its reach", () => {
  // The operator tier used to be asserted against the install pipeline's
  // mint, in `auth/non-http-mint-ceilings.test.ts`. That mint is gone, and
  // this is the only path left that creates a runtime credential, so the
  // assertions belong here or nowhere. A runtime credential is
  // machine-minted with nobody to consent to a widening, which is exactly
  // the shape that must never carry the operator flag or an administrative
  // permission.
  it("holds no space permission, never the operator flag, always expiring", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const cred = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connectionId,
      "keys",
    );

    const credId = await credentialIdByHash(cred.api_key);
    const row = (await ctx.storage.keys.list()).find((k) => k.id === credId);
    if (!row) throw new Error("minted credential did not resolve");
    expect(row.space_permissions ?? []).toEqual([]);
    expect(row.is_operator).toBe(false);
    // Machine-minted means expiring: the substrate cannot refresh
    // mid-dispatch, so an unstamped credential would outlive every
    // dispatch that could replace it.
    expect(row.expires_at).toBeTruthy();
    // Exactly the manifest's declared reach plus the substrate's status
    // channel, never a wildcard.
    const granted = Object.keys(row.type_permissions).sort();
    expect(granted).toEqual(["core.note", "system.activity"]);
    expect(granted).not.toContain("*");
  });
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

    // The carve-out is per-item, not a space-wide system.connection grant:
    // a sibling integration's configuration stays out of reach.
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

  it("REGRESSION: revokes an unexpired sibling too, so a mint leaves one live credential", async () => {
    // This asserted the opposite, on the reasoning that a live credential
    // always belongs to a dispatch that could still be running because the
    // TTL exceeds the dispatch bound. The reasoning was sound and the bound
    // it produced was not: nothing retired a live credential on supersede,
    // so accumulation was limited only by the TTL. Measured on staging,
    // three consecutive mints left five usable credentials.
    //
    // What makes revoking safe is serialisation, not expiry. Dispatches on
    // one connection are serialised — the supervisor holds
    // `connection-dispatch:<id>` around the whole dispatch and mints inside
    // it — so a mint arriving is evidence that no earlier dispatch on this
    // connection still holds its credential.
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

    expect(await ctx.storage.keys.get(firstId)).toBeNull();
  });

  it("REGRESSION: three consecutive dispatches leave exactly one live credential", async () => {
    // The measured shape. Counting is the assertion because the defect was
    // never about one credential surviving — it was about the count growing
    // with traffic.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    for (let i = 0; i < 3; i++) {
      await mintLocalRuntimeCredential(
        ctx.storage,
        TEST_API_KEY_SALT,
        connectionId,
        "keys",
        TTL_MS,
      );
    }

    // listByConnectionId returns live rows only.
    const live = await ctx.storage.keys.listByConnectionId(
      connectionId,
      undefined,
    );
    expect(live.filter((k) => k.is_runtime_credential)).toHaveLength(1);
  });

  it("leaves another connection's credentials alone", async () => {
    // Revoking unconditionally is only correct per connection. A sweep that
    // ignored the connection id would pass both cases above while breaking
    // every other integration in the space.
    const integrationId = await createIntegrationItem();
    const mine = await createActiveConnection(integrationId);
    const theirs = await createActiveConnection(integrationId);

    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      theirs,
      "keys",
      TTL_MS,
    );
    await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      mine,
      "keys",
      TTL_MS,
    );

    const theirLive = await ctx.storage.keys.listByConnectionId(
      theirs,
      undefined,
    );
    expect(theirLive.filter((k) => k.is_runtime_credential)).toHaveLength(1);
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

/**
 * The two rules this mint shares with the hosted one.
 *
 * Every other case in this file runs in `keys` mode, where nothing
 * carries a space and the fence is a deliberate no-op — so the fence
 * could be deleted outright and the whole file would stay green. The
 * cases below boot `hosted` instead, which is the only mode where either
 * rule has anything to say.
 */
describe("mintLocalRuntimeCredential — the substrate's shared rules", () => {
  beforeEach(async () => {
    // Replaces the keys-mode context the outer hook built. `authMode` is
    // fixed when storage is opened, so a hosted case needs its own; the
    // outer `afterEach` cleans up whichever one is current.
    await ctx.cleanup();
    ctx = await createTestContext({ authMode: "hosted" });
  });

  it("refuses to mint for a Connection with no space", async () => {
    // The rule is the substrate's, not the transport's. A space-less
    // credential is not a narrow credential but the platform tier: the
    // RLS wrapper skips a space-less caller and the storage layer drops
    // its space predicate, so the integration reads every space's rows.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    await expect(
      mintLocalRuntimeCredential(
        ctx.storage,
        TEST_API_KEY_SALT,
        connectionId,
        "hosted",
      ),
    ).rejects.toThrow(/no space/i);
  });

  it("keeps minting for a Connection that has one", async () => {
    // The fence must refuse the space-less case and nothing else, or it
    // takes every local integration offline rather than one bad install.
    const space = await ctx.storage.spaces!.create("local-mint-scoped");
    const integrationId = await createIntegrationItem();
    const properties: Record<string, unknown> = {
      kind: "integration",
      status: "active",
      granted_at: new Date().toISOString(),
      integration_ref: integrationId,
    };
    const connection = await ctx.storage.items.create(
      { type: "system.connection", properties },
      space.id,
    );

    const credential = await mintLocalRuntimeCredential(
      ctx.storage,
      TEST_API_KEY_SALT,
      connection.id,
      "hosted",
    );
    expect(credential.connection_id).toBe(connection.id);
  });

  it("blocks on the Connection lifecycle lock and re-reads state under it", async () => {
    // The supervisor's dispatch lock is a different key and does not
    // serialize against uninstall. Without the lifecycle lock the state
    // check below is a snapshot of a decision the uninstall pipeline has
    // already overturned, and the dispatch runs on a credential minted
    // behind a sweep that had revoked everything.
    const space = await ctx.storage.spaces!.create("local-mint-race");
    const integrationId = await createIntegrationItem();
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
          integration_ref: integrationId,
        },
      },
      space.id,
    );

    let settled = false;
    let failure: unknown = null;

    await ctx.storage.coordination.withExclusiveLock(
      `connection-lifecycle:${connection.id}`,
      async () => {
        void mintLocalRuntimeCredential(
          ctx.storage,
          TEST_API_KEY_SALT,
          connection.id,
          "hosted",
        ).catch((err: unknown) => {
          settled = true;
          failure = err;
        });
        // Asserted before the revoke rather than after: what is being
        // pinned is that the mint is still waiting, not merely that it
        // ends up refused. This is an absence check, so it is bounded by
        // time rather than a condition — a blocked promise cannot be made
        // to resolve by scheduling delay, so load can weaken this half
        // toward a vacuous pass but never invert it into a false failure.
        await new Promise((r) => setTimeout(r, 200));
        expect(settled).toBe(false);
        await ctx.storage.items.transition(connection.id, "revoked", space.id);
      },
    );

    // The positive half gates on the condition, not the clock: under
    // machine load the released mint can take far longer than a fixed
    // sleep allows, and this wait costs nothing when it is quick.
    await vi.waitFor(
      () => {
        if (!settled) {
          throw new Error("mint has not settled after the lock released");
        }
      },
      { timeout: 15_000 },
    );
    expect(String(failure)).toMatch(/cannot mint runtime credential/);
  });

  it("refuses a connection that is not there at all, by its own code", async () => {
    // The mint has two refusals and only one of them was ever asserted
    // here. `state !== "active"` is covered above; a row that is gone —
    // or is not a connection — takes the other branch and a different
    // error code, and nothing called the mint directly to check it.
    //
    // It matters now because the supervisor gained a gate that returns
    // before this for the same two cases. A gate and a backstop testing
    // the same conditions are exactly the pair that drifts, and the way
    // that drift stays invisible is one of them having no test of its
    // own. This is the backstop's.
    const missingId = "01a02f00-0000-7000-8000-0000000009f1";

    let failure: unknown = null;
    try {
      await mintLocalRuntimeCredential(
        ctx.storage,
        TEST_API_KEY_SALT,
        missingId,
        "hosted",
      );
    } catch (err) {
      failure = err;
    }
    expect(failure).not.toBeNull();
    expect((failure as { code?: string }).code).toBe("connection_not_found");
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
