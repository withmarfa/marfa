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
import { SqliteOAuthStore } from "./oauth-store.js";
import { SqliteOauthProviderStore } from "./oauth-provider-store.js";
import { SqliteWebhookStore } from "./webhook-store.js";
import { SqliteWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { SqliteInboundWebhookStore } from "./inbound-webhook-store.js";
import { SqliteInboundWebhookEventStore } from "./inbound-webhook-event-store.js";
import { SqliteConnectionOAuthTokenStore } from "./connection-oauth-token-store.js";
import { SqliteConnectionLeasedTokenStore } from "./connection-leased-token-store.js";
import { SqliteAuditStore } from "./audit-store.js";
import { SqliteAuthSessionStore } from "./auth-session-store.js";
import { SqliteEventLogStore } from "./event-log-store.js";
import { SqliteUserStore } from "./user-store.js";
import { SqliteTenantStore } from "./tenant-store.js";
import { SqliteEdgeStore } from "./edge-store.js";
import { SqliteEdgeTypeStore } from "./edge-type-store.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { SqliteCoordinationStore } from "./coordination-store.js";
import { SqliteTenantQuotaStore } from "./tenant-quota-store.js";
import { SqliteRateLimitStore } from "./rate-limit-store.js";
import { SqliteBulkActionJobStore } from "./bulk-action-job-store.js";
import { SqliteAccountLifecycleStore } from "./account-lifecycle-store.js";
import { sqliteDeleteAccountCascade } from "./account-cascade.js";
import {
  registerEdgeTypeSchema,
  isCoreEdgeType,
  registerTypeSchema,
  isCoreType,
} from "@withmarfa/shared";

export async function createSqliteStorage(
  sqlitePath: string,
  options?: {
    versionSnapshotIntervalMs?: number;
    authMode?: "hosted" | "keys";
  },
): Promise<
  Storage & {
    __sqliteAll(query: string): Promise<unknown[]>;
    __sqliteRun(query: string, params: unknown[]): Promise<{ changes: number }>;
    /** Required (not optional) at this concrete factory: the SQLite storage
     *  always exposes a Drizzle handle for the better-auth adapter. The
     *  `Storage` interface widens to optional. */
    betterAuthDb: unknown;
    betterAuthDialect: "sqlite";
  }
> {
  const { db: baseDb, raw, close } = await createConnection(sqlitePath);

  const db = wrapDbWithRequestContext(baseDb);

  const versionStore = new SqliteVersionStore(db);
  const searchStore = new SqliteSearchStore(db);
  const itemStore = new SqliteItemStore(
    db,
    versionStore,
    searchStore,
    options?.versionSnapshotIntervalMs,
  );
  const metadataStore = new SqliteMetadataStore(db);
  const typeStore = new SqliteTypeStore(db);
  const keyStore = new SqliteKeyStore(db);
  const blobStore = new SqliteBlobStore(db);
  const oauthStore = new SqliteOAuthStore(db);
  const webhookStore = new SqliteWebhookStore(db);
  const deliveryStore = new SqliteWebhookDeliveryStore(db);
  const inboundWebhookStore = new SqliteInboundWebhookStore(db);
  const inboundWebhookEventStore = new SqliteInboundWebhookEventStore(db);
  const connectionOauthTokenStore = new SqliteConnectionOAuthTokenStore(db);
  const connectionLeasedTokenStore = new SqliteConnectionLeasedTokenStore(db);
  const auditStore = new SqliteAuditStore(db);
  const eventLogStore = new SqliteEventLogStore(db);
  const authSessionStore = new SqliteAuthSessionStore(db);
  const edgeStore = new SqliteEdgeStore(db);
  const edgeTypeStore = new SqliteEdgeTypeStore(db);

  void edgeTypeStore.loadCustomEdgeTypes().then((types) => {
    for (const { tenant_id, schema } of types) {
      // Register into the owning tenant's overlay so one tenant's custom
      // edge types never resolve for another tenant's lookups.
      if (!isCoreEdgeType(schema.id)) registerEdgeTypeSchema(schema, tenant_id);
    }
  });

  void typeStore.loadCustomTypes().then((types) => {
    for (const { tenant_id, schema } of types) {
      // Register into the owning tenant's overlay so one tenant's custom types
      // never resolve for another tenant's lookups.
      if (!isCoreType(schema.id)) registerTypeSchema(schema, tenant_id);
    }
  });

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
    // Thin reader over the @better-auth/oauth-provider plugin's tables
    // for the consent route and projection after-hooks. The plugin owns writes.
    oauthProvider: new SqliteOauthProviderStore(db),
    outboundWebhooks: webhookStore,
    outboundWebhookDeliveries: deliveryStore,
    inboundWebhooks: inboundWebhookStore,
    inboundWebhookEvents: inboundWebhookEventStore,
    connectionOauthTokens: connectionOauthTokenStore,
    connectionLeasedTokens: connectionLeasedTokenStore,
    audit: auditStore,
    eventLog: eventLogStore,
    authSessions: authSessionStore,
    // Account-lifecycle store reads/writes auth_user's deletion columns.
    // SQLite has no RLS so we use the wrapped instance like the other
    // auth-* stores; transactional consistency is preserved via Drizzle's
    // ALS routing.
    accountLifecycle: new SqliteAccountLifecycleStore(db),
    settings: new SqliteSettingsStore(db),
    coordination: new SqliteCoordinationStore(),
    // Async bulk-action substrate — single-process; see
    // bulk-action-job-store.ts for the claim-without-FOR-UPDATE path.
    bulkActionJobs: new SqliteBulkActionJobStore(db),
    tenantQuotas: new SqliteTenantQuotaStore(db),
    // Rate-limit + per-email throttle counters. Same shape as the PG
    // wiring; SQLite is single-process by file lock so "cluster-shared"
    // collapses to "still correct in-process".
    rateLimits: new SqliteRateLimitStore(db),
    // Tenant store is wired unconditionally so the per-tenant cleanup
    // fan-out works on any deployment, including keys-mode self-hosts
    // that have explicitly created tenant rows. In single-tenant
    // deployments it simply lists zero tenants and the cleanup falls
    // through to the NULL-bucket sweep.
    tenants: new SqliteTenantStore(db),
    ...(options?.authMode === "hosted" && {
      users: new SqliteUserStore(db),
    }),
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
    deleteAccountCascade: (
      authUserId: string,
      cutoffIso: string,
    ): Promise<boolean> => {
      return sqliteDeleteAccountCascade(db, storage, authUserId, cutoffIso);
    },
    betterAuthDb: baseDb,
    betterAuthDialect: "sqlite" as const,
    /** Raw query escape hatch. Originally added for retention tests;
     *  now also consumed by `routes/auth-account.ts`
     *  (auth_verification probes — JSON1 operators not naturally
     *  expressible in Drizzle). Production callers exist. */
    async __sqliteAll(query: string): Promise<unknown[]> {
      const result = await raw.execute(query);
      return result.rows;
    },
    /** Parameterised raw mutation escape hatch — used by retention tests
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
      await close();
    },
  };

  return storage;
}
