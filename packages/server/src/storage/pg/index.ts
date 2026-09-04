import {
  registerTypeSchema,
  registerEdgeTypeSchema,
  isCoreEdgeType,
  seedPlatformTypes as seedPlatformRegistry,
  shippedPlatformTypes,
} from "@withmarfa/shared";
import type { DbPoolMode } from "../../config.js";
import type { Storage } from "../interface.js";
import { createConnection } from "./connection.js";
import { PgItemStore } from "./item-store.js";
import { PgMetadataStore } from "./metadata-store.js";
import { PgVersionStore } from "./version-store.js";
import { PgTypeStore } from "./type-store.js";
import { PgSearchStore } from "./search-store.js";
import { PgKeyStore } from "./key-store.js";
import { PgBlobStore } from "./blob-store.js";
import { PgOAuthStore } from "./oauth-store.js";
import { PgOauthProviderStore } from "./oauth-provider-store.js";
import { PgWebhookStore } from "./webhook-store.js";
import { PgWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { PgInboundWebhookStore } from "./inbound-webhook-store.js";
import { PgInboundWebhookEventStore } from "./inbound-webhook-event-store.js";
import { PgConnectionOAuthTokenStore } from "./connection-oauth-token-store.js";
import { PgConnectionLeasedTokenStore } from "./connection-leased-token-store.js";
import { PgAuditStore } from "./audit-store.js";
import { PgAuthSessionStore } from "./auth-session-store.js";
import { PgEventLogStore } from "./event-log-store.js";
import { PgUserStore } from "./user-store.js";
import { PgSpaceStore } from "./space-store.js";
import { PgEdgeStore } from "./edge-store.js";
import { PgEdgeTypeStore } from "./edge-type-store.js";
import { PgEnrichmentStore } from "./enrichment-store.js";
import { PgSettingsStore } from "./settings-store.js";
import { PgCoordinationStore } from "./coordination-store.js";
import { PgSpaceQuotaStore } from "./space-quota-store.js";
import { PgRateLimitStore } from "./rate-limit-store.js";
import { PgBulkActionJobStore } from "./bulk-action-job-store.js";
import { PgIdempotencyStore } from "./idempotency-store.js";
import { PgAccountLifecycleStore } from "./account-lifecycle-store.js";
import { pgDeleteAccountCascade, pgDeleteSpace } from "./account-cascade.js";
import { pgRequestContext } from "./request-context.js";
import { reportSeedCollisions } from "../seed-collisions.js";
import { projectPlatformRows } from "../platform-family.js";
import { reportReservedRootRows } from "../reserved-root-rows.js";
import { computePlatformDrift, setPlatformDrift } from "../platform-drift.js";
import { scanStoredValues, setStoredValueScan } from "../stored-value-scan.js";
import { pgStoredValueCounts } from "./stored-value-counts.js";

export async function createPgStorage(
  connectionString: string,
  options?: {
    authMode?: "hosted" | "keys";
    /** Override the postgres-js pool size (default 10). Used by the
     *  test fixture (`createPgTestStorage`) to cap each per-file pool
     *  so parallel test files don't exhaust `max_connections`. */
    maxPoolSize?: number;
    /** Skip the bootstrap `SCHEMA_SQL` + migration-journal stamp. The
     *  test fixture passes `true` because cloned-from-template databases
     *  already have the schema. */
    skipBootstrap?: boolean;
    /** Direct (session-mode) connection string for streaming RLS — see
     *  `createConnection`. Keeps streaming's session-level `SET ROLE` off
     *  the app's transaction-mode pooled connections. */
    directConnectionString?: string;
    /** What kind of endpoint `connectionString` points at. `transaction`
     *  makes `directConnectionString` mandatory — see `createConnection`. */
    poolMode?: DbPoolMode;
    /** Label this process's connections carry into `pg_stat_activity` —
     *  see `createConnection`. */
    applicationName?: string;
  },
): Promise<Storage> {
  const {
    db,
    baseDb,
    client,
    sessionClient,
    jobHolderClient,
    lockClient,
    close,
  } = await createConnection(connectionString, {
    maxPoolSize: options?.maxPoolSize,
    skipBootstrap: options?.skipBootstrap,
    directConnectionString: options?.directConnectionString,
    poolMode: options?.poolMode,
    applicationName: options?.applicationName,
  });

  const versionStore = new PgVersionStore(db);
  const searchStore = new PgSearchStore(db, client);
  const itemStore = new PgItemStore(db, versionStore, searchStore);
  const metadataStore = new PgMetadataStore(db);
  const typeStore = new PgTypeStore(db);

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
  const loadedTypes = await typeStore.loadCustomTypes();
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
  // aggregate per scanned column, awaited for the same reason the seed and
  // the registry fill above are: a value recorded after storage is handed
  // back is a value some request can miss, and reporting zero because the
  // scan has not finished is the dishonest answer. It reports and never
  // refuses — reasoning at the helper, and it is the same judgment the two
  // lines above make.
  setStoredValueScan(
    await scanStoredValues(pgStoredValueCounts((sql) => client.unsafe(sql))),
  );
  for (const row of loadedTypes) {
    if (row.origin === "platform") continue;
    // Register into the owning space's overlay so one space's custom types
    // never resolve for another space's lookups. The empty-string sentinel
    // maps to the null-space bucket.
    registerTypeSchema(row.schema, row.space_id);
  }
  seedPlatformRegistry(platformRows);

  const keyStore = new PgKeyStore(db);
  const blobStore = new PgBlobStore(db);
  const oauthStore = new PgOAuthStore(db);
  const webhookStore = new PgWebhookStore(db);
  const deliveryStore = new PgWebhookDeliveryStore(db);
  const inboundWebhookStore = new PgInboundWebhookStore(db);
  const inboundWebhookEventStore = new PgInboundWebhookEventStore(db);
  const connectionOauthTokenStore = new PgConnectionOAuthTokenStore(db);
  const connectionLeasedTokenStore = new PgConnectionLeasedTokenStore(db);
  const auditStore = new PgAuditStore(db);
  const eventLogStore = new PgEventLogStore(db);
  const authSessionStore = new PgAuthSessionStore(baseDb);
  const edgeStore = new PgEdgeStore(db);
  const edgeTypeStore = new PgEdgeTypeStore(db);

  const loadedCustomEdgeTypes = await edgeTypeStore.loadCustomEdgeTypes();
  for (const { space_id, schema } of loadedCustomEdgeTypes) {
    if (!isCoreEdgeType(schema.id)) {
      // Register into the owning space's overlay so one space's custom
      // edge types never resolve for another space's lookups. The
      // empty-string sentinel maps to the null-space bucket.
      registerEdgeTypeSchema(schema, space_id);
    }
  }

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
    oauth: oauthStore,
    // Thin reader over the plugin's tables for the consent route +
    // projection after-hooks. The plugin itself owns writes.
    oauthProvider: new PgOauthProviderStore(db),
    outboundWebhooks: webhookStore,
    outboundWebhookDeliveries: deliveryStore,
    inboundWebhooks: inboundWebhookStore,
    inboundWebhookEvents: inboundWebhookEventStore,
    connectionOauthTokens: connectionOauthTokenStore,
    connectionLeasedTokens: connectionLeasedTokenStore,
    audit: auditStore,
    eventLog: eventLogStore,
    authSessions: authSessionStore,
    // account-lifecycle store reads/writes auth_user's deletion columns.
    // Lives on the unwrapped base instance because the auth_* tables are
    // RLS-bypassed (better-auth manages its own context).
    accountLifecycle: new PgAccountLifecycleStore(baseDb),
    settings: new PgSettingsStore(db),
    coordination: new PgCoordinationStore(
      client,
      db,
      lockClient,
      sessionClient,
      jobHolderClient,
    ),
    // Async substrate for bulk_action. Wired on the wrapped instance so
    // RLS scopes its space_id reads/writes per request; the worker runs
    // outside a request and bypasses RLS via the unwrapped path on
    // `client.reserve()` — not needed in the store class itself, only at
    // the worker boundary.
    bulkActionJobs: new PgBulkActionJobStore(db),
    // On `baseDb`, deliberately. A claim has to commit whether or not the
    // write's own transaction does, so it must never join one — and the
    // table is granted to nobody but the owner, so a future caller that
    // put it inside the RLS wrapper would fail loudly rather than
    // silently taking the request's transaction.
    idempotency: new PgIdempotencyStore(baseDb),
    spaceQuotas: new PgSpaceQuotaStore(db),
    // Cluster-shared rate-limit + per-email throttle counters. Wired on
    // the wrapped instance so the request-context RLS proxy doesn't bypass
    // it; the rate-limit table is platform-internal (no space_id column,
    // no RLS policy) and the queries target global counters by design.
    rateLimits: new PgRateLimitStore(db),
    // Deterministic text-enrichment bookkeeping for the sweeper.
    enrichment: new PgEnrichmentStore(db),
    // Space store wired unconditionally — see sqlite index.ts for the
    // rationale. The fan-out on space cleanup needs `spaces.list`
    // available regardless of authMode.
    spaces: new PgSpaceStore(db),
    ...(options?.authMode === "hosted" && {
      users: new PgUserStore(db),
    }),
    /**
     * Opens a Drizzle transaction via `db.transaction(async tx => …)` and
     * installs `tx` on `pgRequestContext` so every store call inside `fn`
     * resolves its executor to the transaction via the proxy in
     * `request-context.ts`. All work inside `fn` runs on the transaction's
     * reserved connection; rollback is real on throw.
     *
     * The ALS installation is critical: without it, storage calls inside
     * `fn` fall through to the unwrapped base instance and acquire SECOND
     * pool connections per query while the `begin` connection sits `idle in
     * transaction` — under concurrent writes the pool saturates and every
     * `runInTransaction` callback blocks acquiring an inner connection.
     *
     * Goes through the wrapped `db`: when the caller is already inside the
     * RLS middleware's transaction (a space-scoped request), the proxy
     * resolves `transaction` against the existing `tx` and Drizzle issues a
     * SAVEPOINT — staying on the middleware's connection and preserving RLS
     * isolation. Outside a request (retention jobs, single-space self-host),
     * the proxy falls through to `baseDb` and opens a fresh transaction on
     * the owner connection. Either way the inner work shares one pool slot,
     * not two.
     */
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => {
        return await pgRequestContext.run({ tx }, async () => fn());
      });
    },
    deleteSpace: (
      spaceId: string,
    ): Promise<"deleted" | "not_found" | "has_users"> => {
      // Same unwrapped base instance and the same reason as the cascade
      // below: the sweep crosses the space boundary by design.
      return pgDeleteSpace(baseDb, storage, spaceId);
    },
    deleteAccountCascade: (
      authUserId: string,
      cutoffIso: string,
    ): Promise<boolean> => {
      // The cascade runs on the unwrapped base instance — auth_* tables
      // are RLS-bypassed and this operation crosses space/auth boundaries
      // by design.
      return pgDeleteAccountCascade(baseDb, storage, authUserId, cutoffIso);
    },
    // Drain in-flight fire-and-forget audit writes before tearing down the
    // pool. Without this, an audit insert still in flight when `close()` runs
    // rejects with CONNECTION_ENDED once the pool ends — an unhandled
    // rejection (the test harness drops the per-file clone right after close,
    // making the window easy to hit). Draining lets pending writes settle
    // first; `drain()` itself never rejects.
    close: async () => {
      await Promise.all([auditStore.drain(), oauthStore.drain()]);
      await close();
    },
    /** Raw query escape hatch. Originally added for parameterized
     *  mutations in retention tests; now also consumed by
     *  `routes/auth-account.ts` (auth_verification probes via the
     *  better-auth-managed table — JSON operators not naturally
     *  expressible in Drizzle). Production callers exist; rename is a
     *  real blast-radius change. */
    __pgClient(query: string, params?: unknown[]): Promise<unknown[]> {
      return params
        ? client.unsafe(query, params as (string | number | boolean)[])
        : client.unsafe(query);
    },
    betterAuthDb: baseDb,
    betterAuthDialect: "pg" as const,
    pgDb: db,
    pgClient: client,
    pgStreamClient: sessionClient,
  } satisfies Storage & {
    __pgClient(query: string, params?: unknown[]): Promise<unknown[]>;
    betterAuthDb: unknown;
    betterAuthDialect: "pg";
  };

  return storage;
}
