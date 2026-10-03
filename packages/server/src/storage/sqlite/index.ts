import { readSnapshotRunner } from "./read-snapshot.js";
import { initializeStructuralGeneration } from "./structural-generation.js";
import { ensureInstanceId } from "../instance-id.js";
import { publishBootRegistry } from "./registry-context.js";
import { assertTransactionUsable } from "./transaction-control.js";
import type { Storage } from "../interface.js";
import { createConnection } from "./connection.js";
import {
  wrapDbWithRequestContext,
  guardStoreWithReadContext,
  sqliteRequestContext,
} from "./request-context.js";
import { withCommitHooks } from "../commit-hooks.js";
import { SqliteItemStore } from "./item-store.js";
import { SqliteMetadataStore } from "./metadata-store.js";
import { SqliteVersionStore } from "./version-store.js";
import { SqliteTypeStore } from "./type-store.js";
import { SqliteSearchStore } from "./search-store.js";
import { SqliteKeyStore } from "./key-store.js";
import { SqliteBlobRegistry } from "./blob-registry.js";
import { SqliteOauthProviderStore } from "./oauth-provider-store.js";
import { SqliteWebhookStore } from "./webhook-store.js";
import { SqliteWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { SqliteAuditStore } from "./audit-store.js";
import { SqliteAuthSessionStore } from "./auth-session-store.js";
import { SqliteOwnerStore } from "./owner-store.js";
import { SqliteEventLogStore } from "./event-log-store.js";
import { SqliteEdgeStore } from "./edge-store.js";
import { SqliteEdgeTypeStore } from "./edge-type-store.js";
import { SqliteEnrichmentStore } from "./enrichment-store.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { SqliteRateLimitStore } from "./rate-limit-store.js";
import { SqliteBulkActionJobStore } from "./bulk-action-job-store.js";
import { SqliteIdempotencyStore } from "./idempotency-store.js";
import { SqliteHousekeepingStore } from "./housekeeping-store.js";
import { SqliteConnectorStore } from "./connector-store.js";
import { SqliteConnectorStateStore } from "./connector-state-store.js";
import { SqliteInboundStore } from "./inbound-store.js";
import {
  reportEdgeNameCollisions,
  reportSeedCollisions,
} from "../seed-collisions.js";
import { projectPlatformRows } from "../platform-family.js";
import { reportReservedRootRows } from "../reserved-root-rows.js";
import { computePlatformDrift, setPlatformDrift } from "../platform-drift.js";
import { scanStoredValues, setStoredValueScan } from "../stored-value-scan.js";
import { sqliteStoredValueCounts } from "./stored-value-counts.js";
import {
  isCoreEdgeType,
  edgeNameCollisions,
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
  const {
    db: baseDb,
    raw,
    inspectQueryPlan,
    close,
    captureRead,
  } = await createConnection(sqlitePath);

  try {
    await initializeStructuralGeneration(raw);
  } catch (error) {
    await close();
    throw error;
  }
  const db = wrapDbWithRequestContext(baseDb);
  await ensureInstanceId(new SqliteSettingsStore(db));

  const versionStore = new SqliteVersionStore(db);
  const searchStore = new SqliteSearchStore(db);
  const itemStore = new SqliteItemStore(db, versionStore, searchStore);
  const metadataStore = new SqliteMetadataStore(db, searchStore);
  const typeStore = new SqliteTypeStore(db);
  const keyStore = new SqliteKeyStore(db);
  const blobRegistry = new SqliteBlobRegistry(db);
  const eventLogStore = new SqliteEventLogStore(db);
  const webhookStore = new SqliteWebhookStore(db, eventLogStore);
  const deliveryStore = new SqliteWebhookDeliveryStore(db);
  const auditStore = new SqliteAuditStore(db);
  const authSessionStore = new SqliteAuthSessionStore(db);
  const edgeStore = new SqliteEdgeStore(db);
  const edgeTypeStore = new SqliteEdgeTypeStore(db);
  const enrichmentStore = new SqliteEnrichmentStore(db);
  const oauthProviderStore = new SqliteOauthProviderStore(db);

  // Awaited for the same reason as the type warmup below: a registry filled
  // after storage is handed back is a registry some request can miss.
  const loadedEdgeTypes = await edgeTypeStore.list();
  const initialTypes = await typeStore.loadAll();
  publishBootRegistry({
    platform: projectPlatformRows(initialTypes),
    custom: initialTypes
      .filter((row) => row.origin !== "platform")
      .map((row) => row.schema),
    edges: loadedEdgeTypes.filter((schema) => !isCoreEdgeType(schema.id)),
  });

  // Awaited rather than fire-and-forget: the platform vocabulary is seeded
  // data, so returning storage before the registry is filled opens a window
  // in which `core.note` does not resolve and ordinary writes fail
  // validation for a type that plainly exists.
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
  publishBootRegistry({
    platform: platformRows,
    custom: loadedTypes
      .filter((row) => row.origin !== "platform")
      .map((row) => row.schema),
    edges: loadedEdgeTypes.filter((schema) => !isCoreEdgeType(schema.id)),
  });
  reportEdgeNameCollisions(edgeNameCollisions());

  const storage = {
    items: guardStoreWithReadContext(itemStore),
    metadata: guardStoreWithReadContext(metadataStore),
    versions: guardStoreWithReadContext(versionStore),
    types: guardStoreWithReadContext(typeStore),
    search: guardStoreWithReadContext(searchStore),
    keys: guardStoreWithReadContext(keyStore),
    blobs: guardStoreWithReadContext(blobRegistry),
    edges: guardStoreWithReadContext(edgeStore),
    edgeTypes: guardStoreWithReadContext(edgeTypeStore),
    enrichment: guardStoreWithReadContext(enrichmentStore),
    // Shared provider-table access joins credential and grant transactions.
    oauthProvider: guardStoreWithReadContext(oauthProviderStore),
    outboundWebhooks: guardStoreWithReadContext(webhookStore),
    outboundWebhookDeliveries: guardStoreWithReadContext(deliveryStore),
    audit: guardStoreWithReadContext(auditStore),
    eventLog: guardStoreWithReadContext(eventLogStore),
    authSessions: guardStoreWithReadContext(authSessionStore),
    owner: guardStoreWithReadContext(new SqliteOwnerStore(db)),
    settings: guardStoreWithReadContext(new SqliteSettingsStore(db)),
    // `bulk-action-job-store.ts` carries how a job is claimed without two
    // loops taking the same one.
    bulkActionJobs: guardStoreWithReadContext(new SqliteBulkActionJobStore(db)),
    // A claim has to commit whether or not the write's own transaction
    // does, and `db` is the only instance there is.
    idempotency: guardStoreWithReadContext(new SqliteIdempotencyStore(db)),
    rateLimits: guardStoreWithReadContext(new SqliteRateLimitStore(db)),
    housekeeping: guardStoreWithReadContext(new SqliteHousekeepingStore(db)),
    connectors: guardStoreWithReadContext(new SqliteConnectorStore(db)),
    connectorState: guardStoreWithReadContext(
      new SqliteConnectorStateStore(db),
    ),
    inbound: guardStoreWithReadContext(new SqliteInboundStore(db)),
    /**
     * Through the wrapped handle, so a call made inside an open transaction
     * becomes a savepoint of it, as the stores' own transactions do.
     */
    assertTransactionUsable() {
      assertTransactionUsable();
      const scope = sqliteRequestContext.getStore();
      if (scope?.mode === "read") scope.assertActive();
    },
    runInReadSnapshot: readSnapshotRunner(captureRead),
    async runInTransaction<T>(
      fn: () => T | Promise<T>,
      options?: { retainCommitHooksOnUncertain?: boolean },
    ): Promise<T> {
      return await withCommitHooks(
        (body) => db.transaction(async () => await body()),
        fn,
        options?.retainCommitHooksOnUncertain,
      );
    },
    betterAuthDb: db,
    /** Raw query escape hatch for the storage tests; nothing outside a
     *  test calls it. */
    async __sqliteAll(query: string): Promise<unknown[]> {
      const result = /^\s*EXPLAIN\b/i.test(query)
        ? await inspectQueryPlan(query)
        : await raw.execute(query);
      return result.rows;
    },
    /** Parameterized raw mutation escape hatch, reached by `test-utils`
     *  and by tests directly, to plant values no door writes. */
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
      // Operational last-used stamps remain asynchronous; audits are awaited
      // by their owning operation and have no detached shutdown work.
      await oauthProviderStore.drain();
      await close();
    },
  };

  // Initialize only a genuinely empty local instance. Invalid persisted state
  // is diagnosed by the scheduling job rather than silently skipped at open.
  await storage.runInTransaction(() => webhookStore.initialize());
  return storage;
}
