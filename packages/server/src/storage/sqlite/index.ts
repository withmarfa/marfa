import type { Storage } from "../interface.js";
import { createConnection } from "./connection.js";
import { wrapDbWithRequestContext, withSqliteTx } from "./request-context.js";
import { SqliteItemStore } from "./item-store.js";
import { SqliteMetadataStore } from "./metadata-store.js";
import { SqliteVersionStore } from "./version-store.js";
import { SqliteTypeStore } from "./type-store.js";
import { SqliteSearchStore } from "./search-store.js";
import { SqliteKeyStore } from "./key-store.js";
import { SqliteBlobStore } from "./blob-store.js";
import { SqliteOauthProviderStore } from "./oauth-provider-store.js";
import { SqliteWebhookStore } from "./webhook-store.js";
import { SqliteWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { SqliteAuditStore } from "./audit-store.js";
import { SqliteAuthSessionStore } from "./auth-session-store.js";
import { SqliteEventLogStore } from "./event-log-store.js";
import { SqliteEdgeStore } from "./edge-store.js";
import { SqliteEdgeTypeStore } from "./edge-type-store.js";
import { SqliteEnrichmentStore } from "./enrichment-store.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { SqliteRateLimitStore } from "./rate-limit-store.js";
import { SqliteBulkActionJobStore } from "./bulk-action-job-store.js";
import { SqliteIdempotencyStore } from "./idempotency-store.js";
import { reportSeedCollisions } from "../seed-collisions.js";
import { projectPlatformRows } from "../platform-family.js";
import { reportReservedRootRows } from "../reserved-root-rows.js";
import { computePlatformDrift, setPlatformDrift } from "../platform-drift.js";
import { scanStoredValues, setStoredValueScan } from "../stored-value-scan.js";
import { sqliteStoredValueCounts } from "./stored-value-counts.js";
import {
  registerEdgeTypeSchema,
  isCoreEdgeType,
  registerTypeSchema,
  seedPlatformTypes as seedPlatformRegistry,
  shippedPlatformTypes,
} from "@withmarfa/shared";

export async function createSqliteStorage(sqlitePath: string): Promise<
  Storage & {
    __sqliteAll(query: string): Promise<unknown[]>;
    __sqliteRun(query: string, params: unknown[]): Promise<{ changes: number }>;
    /** Required (not optional) at this concrete factory: the SQLite storage
     *  always exposes a Drizzle handle for the better-auth adapter. The
     *  `Storage` interface widens to optional. */
    betterAuthDb: unknown;
  }
> {
  const { db: baseDb, raw, close } = await createConnection(sqlitePath);

  const db = wrapDbWithRequestContext(baseDb);

  const versionStore = new SqliteVersionStore(db);
  const searchStore = new SqliteSearchStore(db);
  const itemStore = new SqliteItemStore(db, versionStore, searchStore);
  const metadataStore = new SqliteMetadataStore(db, searchStore);
  const typeStore = new SqliteTypeStore(db);
  const keyStore = new SqliteKeyStore(db);
  const blobStore = new SqliteBlobStore(db);
  const webhookStore = new SqliteWebhookStore(db);
  const deliveryStore = new SqliteWebhookDeliveryStore(db);
  const auditStore = new SqliteAuditStore(db);
  const eventLogStore = new SqliteEventLogStore(db);
  const authSessionStore = new SqliteAuthSessionStore(db);
  const edgeStore = new SqliteEdgeStore(db);
  const edgeTypeStore = new SqliteEdgeTypeStore(db);
  const enrichmentStore = new SqliteEnrichmentStore(db);
  const oauthProviderStore = new SqliteOauthProviderStore(db);

  // Awaited for the same reason as the type warmup below: a registry filled
  // after storage is handed back is a registry some request can miss.
  const loadedEdgeTypes = await edgeTypeStore.list();
  for (const schema of loadedEdgeTypes) {
    if (!isCoreEdgeType(schema.id)) registerEdgeTypeSchema(schema);
  }

  // Awaited, unlike the fire-and-forget this used to be. That was harmless
  // only while the platform vocabulary was compiled in and resolved before any request
  // could arrive. It is seeded data now, so returning storage before the
  // registry is filled opens a window in which `core.note` does not resolve
  // and ordinary writes fail validation for a type that plainly exists.
  // The platform vocabulary is data this instance holds, not a fact about the
  // build it happens to be running. Seed the shipped set into rows (an upsert,
  // so a redeploy carrying a changed schema moves the row), then fill the
  // in-memory registry from what the rows actually say. A type added by a seed
  // alone therefore resolves without a redeploy, and an instance never
  // resolves something its own rows do not carry.
  // The seed leaves a colliding registration alone and answers with its id;
  // reporting it is the whole of the handling, and the reasoning for that is
  // at the reporter.
  reportSeedCollisions(
    await typeStore.seedPlatformTypes(shippedPlatformTypes()),
  );
  const loadedTypes = await typeStore.loadAll();
  // A platform row whose family this build cannot read is placed at the
  // restrictive end rather than defaulted to `core`, which was the
  // permissive one. Reasoning, and why this projects rather than refusing
  // to boot, is at the helper.
  const platformRows = projectPlatformRows(loadedTypes);
  // A row under a reserved root that names no tier — a type whose identifier
  // collides with a permission literal. Registration cannot produce one;
  // reserving a root after the fact can. Reported and never acted on, on the
  // same judgment the projection above makes.
  reportReservedRootRows(loadedTypes);
  // What this instance still carries that the build no longer ships. Recorded
  // rather than acted on: the reasoning for reporting instead of pruning is
  // at the helper, and it is the same judgment the projection above makes
  // one line up.
  setPlatformDrift(computePlatformDrift(shippedPlatformTypes(), loadedTypes));
  // How many rows this instance holds that no build understands. One
  // aggregate per scanned column, awaited for the reason the type warmup
  // above is: a value recorded after storage is handed back is a value
  // some request can miss, and reporting zero because the scan has not
  // finished is the dishonest answer. It reports and never refuses —
  // reasoning at the helper, and it is the same judgment the two lines
  // above make.
  setStoredValueScan(
    await scanStoredValues(
      sqliteStoredValueCounts(async (sql) => (await raw.execute(sql)).rows),
    ),
  );
  for (const row of loadedTypes) {
    if (row.origin === "platform") continue;
    registerTypeSchema(row.schema);
  }
  seedPlatformRegistry(platformRows);

  const storage = {
    items: itemStore,
    metadata: metadataStore,
    versions: versionStore,
    types: typeStore,
    search: searchStore,
    keys: keyStore,
    blobs: blobStore,
    edges: edgeStore,
    edgeTypes: edgeTypeStore,
    enrichment: enrichmentStore,
    // Thin reader over the @better-auth/oauth-provider plugin's tables
    // for the consent route and projection after-hooks. The plugin owns writes.
    oauthProvider: oauthProviderStore,
    outboundWebhooks: webhookStore,
    outboundWebhookDeliveries: deliveryStore,
    audit: auditStore,
    eventLog: eventLogStore,
    authSessions: authSessionStore,
    settings: new SqliteSettingsStore(db),
    // Async bulk-action substrate — single-process; see
    // bulk-action-job-store.ts for the claim-without-FOR-UPDATE path.
    bulkActionJobs: new SqliteBulkActionJobStore(db),
    // A claim has to commit whether or not the write's own transaction
    // does, and `db` is the only instance there is.
    idempotency: new SqliteIdempotencyStore(db),
    // Rate-limit + per-email throttle counters. Same shape as the PG
    // wiring; SQLite is single-process by file lock so "cluster-shared"
    // collapses to "still correct in-process".
    rateLimits: new SqliteRateLimitStore(db),
    /**
     * Genuinely transactional under libsql + ALS routing. Opens a libsql
     * `BEGIN IMMEDIATE` via Drizzle's `db.transaction(async tx => …)`,
     * stores `tx` on the per-request ALS so every store call inside `fn`
     * resolves its executor to the transaction, and rolls back on throw.
     * Rollback is real — not a no-op for async bodies.
     */
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      return await baseDb.transaction(async (tx) => {
        return await withSqliteTx(tx, async () => fn());
      });
    },
    betterAuthDb: baseDb,
    /** Raw query escape hatch. Originally added for retention tests;
     *  now also consumed by `routes/auth-account.ts`
     *  (auth_verification probes — JSON1 operators not naturally
     *  expressible in Drizzle). Production callers exist. */
    async __sqliteAll(query: string): Promise<unknown[]> {
      const result = await raw.execute(query);
      return result.rows;
    },
    /** Parameterized raw mutation escape hatch — used by retention tests
     *  that need to plant non-default `updated_at` values. */
    async __sqliteRun(
      query: string,
      params: unknown[],
    ): Promise<{ changes: number }> {
      const result = await raw.execute({
        sql: query,
        args: params as (string | number | boolean | null)[],
      });
      return { changes: result.rowsAffected };
    },
    async close() {
      // Drain in-flight fire-and-forget writes (audit rows and the OAuth
      // last-used stamp) before closing the underlying connection, so a
      // late write can't fail against a closed store. Neither drain
      // rejects.
      await Promise.all([auditStore.drain(), oauthProviderStore.drain()]);
      await close();
    },
  };

  return storage;
}
