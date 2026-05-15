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
import { SqliteAccountLifecycleStore } from "./account-lifecycle-store.js";
import { sqliteDeleteAccountCascade } from "./account-cascade.js";
import {
  registerEdgeTypeSchema,
  isCoreEdgeType,
  registerTypeSchema,
  isCoreType,
} from "@mymehq/shared";

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

  // Wrap the Drizzle instance with the per-request context proxy. Stores
  // capture the wrapped instance and call `this.db.foo()` unchanged; the
  // proxy redirects to the active transaction when one is in flight (set
  // by `runInTransaction` below) and falls through to the base instance
  // otherwise.
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
  // T-097: auth_session sweep — instance-wide, no tenant scoping.
  const authSessionStore = new SqliteAuthSessionStore(db);
  const edgeStore = new SqliteEdgeStore(db);
  const edgeTypeStore = new SqliteEdgeTypeStore(db);

  // Warm up the in-memory edge-type registry from the custom_edge_types
  // table. Fire-and-forget: if the DB is empty (fresh test) this is a
  // no-op, and new rows added at runtime are registered on POST /edges/types.
  void edgeTypeStore.loadCustomEdgeTypes().then((types) => {
    for (const ct of types) {
      if (!isCoreEdgeType(ct.id)) registerEdgeTypeSchema(ct);
    }
  });

  // Same pattern for the custom-type registry. T-071: pre-driver-swap this
  // ran synchronously in the SqliteTypeStore constructor via better-sqlite3;
  // libsql is async-only, so it's now an explicit fire-and-forget warm-up.
  void typeStore.loadCustomTypes().then((types) => {
    for (const t of types) {
      if (!isCoreType(t.id)) registerTypeSchema(t);
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
    outboundWebhooks: webhookStore,
    outboundWebhookDeliveries: deliveryStore,
    inboundWebhooks: inboundWebhookStore,
    inboundWebhookEvents: inboundWebhookEventStore,
    connectionOauthTokens: connectionOauthTokenStore,
    connectionLeasedTokens: connectionLeasedTokenStore,
    audit: auditStore,
    eventLog: eventLogStore,
    authSessions: authSessionStore,
    // T-116: account-lifecycle store reads/writes auth_user's deletion
    // columns. SQLite has no RLS so we use the wrapped instance like
    // the other auth-* stores; transactional consistency is preserved
    // via Drizzle's ALS routing.
    accountLifecycle: new SqliteAccountLifecycleStore(db),
    settings: new SqliteSettingsStore(db),
    coordination: new SqliteCoordinationStore(),
    tenantQuotas: new SqliteTenantQuotaStore(db),
    // T-026: cluster-shared rate-limit + per-email throttle counters.
    // Same shape as the PG wiring; SQLite is single-process by file
    // lock so "shared" collapses to "still correct in-process".
    rateLimits: new SqliteRateLimitStore(db),
    // T-050: tenant store is wired unconditionally so the per-tenant
    // cleanup fan-out works on any deployment, including keys-mode
    // self-hosts that have explicitly created tenant rows. The hosted-
    // mode gate previously here was stale — the store is harmless in
    // single-tenant deployments (it just lists zero tenants and the
    // cleanup falls through to the NULL-bucket sweep).
    tenants: new SqliteTenantStore(db),
    ...(options?.authMode === "hosted" && {
      users: new SqliteUserStore(db),
    }),
    /**
     * Genuinely transactional under libsql + ALS routing (T-071). Opens a
     * libsql `BEGIN IMMEDIATE` via Drizzle's `db.transaction(async tx => …)`,
     * stores `tx` on the per-request ALS so every store call inside `fn`
     * resolves its executor to the transaction, and rolls back on throw.
     *
     * Pre-T-071 this was a silent no-op for async bodies (better-sqlite3
     * has no async transaction API). The shim is gone; rollback is real.
     */
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      return await baseDb.transaction(async (tx) => {
        return await withSqliteTx(tx, async () => fn());
      });
    },
    deleteAccountCascade: (authUserId: string): Promise<void> => {
      return sqliteDeleteAccountCascade(
        db,
        storage as unknown as Storage,
        authUserId,
      );
    },
    betterAuthDb: baseDb,
    betterAuthDialect: "sqlite" as const,
    /** Raw query escape hatch — used by retention tests. */
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
