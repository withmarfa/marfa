import {
  registerTypeSchema,
  isCoreType,
  registerEdgeTypeSchema,
  isCoreEdgeType,
} from "@withmarfa/shared";
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
import { PgTenantStore } from "./tenant-store.js";
import { PgEdgeStore } from "./edge-store.js";
import { PgEdgeTypeStore } from "./edge-type-store.js";
import { PgSettingsStore } from "./settings-store.js";
import { PgCoordinationStore } from "./coordination-store.js";
import { PgTenantQuotaStore } from "./tenant-quota-store.js";
import { PgRateLimitStore } from "./rate-limit-store.js";
import { PgBulkActionJobStore } from "./bulk-action-job-store.js";
import { PgAccountLifecycleStore } from "./account-lifecycle-store.js";
import { pgDeleteAccountCascade } from "./account-cascade.js";
import { pgRequestContext } from "./request-context.js";

export async function createPgStorage(
  connectionString: string,
  options?: {
    versionSnapshotIntervalMs?: number;
    authMode?: "hosted" | "keys";
    /** Override the postgres-js pool size (default 10). Used by the
     *  test fixture (`createPgTestStorage`) to cap each per-file pool
     *  so parallel test files don't exhaust `max_connections`. */
    maxPoolSize?: number;
    /** Skip the bootstrap `SCHEMA_SQL` + migration-journal stamp. The
     *  test fixture passes `true` because cloned-from-template databases
     *  already have the schema. */
    skipBootstrap?: boolean;
  },
): Promise<Storage> {
  // `db` is the wrapped Drizzle instance (per-request RLS context aware);
  // `baseDb` is the raw owner-connection instance reserved for Better Auth.
  // T-025 part 2: see `request-context.ts` for the substitution mechanic.
  const { db, baseDb, client, close } = await createConnection(
    connectionString,
    {
      maxPoolSize: options?.maxPoolSize,
      skipBootstrap: options?.skipBootstrap,
    },
  );

  const versionStore = new PgVersionStore(db);
  const searchStore = new PgSearchStore(db, client);
  const itemStore = new PgItemStore(
    db,
    versionStore,
    searchStore,
    options?.versionSnapshotIntervalMs,
  );
  const metadataStore = new PgMetadataStore(db);
  const typeStore = new PgTypeStore(db);

  // Load custom types from the database and register them in memory
  const loadedCustomTypes = await typeStore.loadCustomTypes();
  for (const ct of loadedCustomTypes) {
    if (!isCoreType(ct.id)) {
      registerTypeSchema(ct);
    }
  }
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
  // T-097: auth_session sweep runs against the unwrapped owner instance,
  // matching how better-auth itself talks to its tables (baseDb).
  const authSessionStore = new PgAuthSessionStore(baseDb);
  const edgeStore = new PgEdgeStore(db);
  const edgeTypeStore = new PgEdgeTypeStore(db);

  // Load custom edge types into the in-memory registry on startup.
  const loadedCustomEdgeTypes = await edgeTypeStore.loadCustomEdgeTypes();
  for (const ct of loadedCustomEdgeTypes) {
    if (!isCoreEdgeType(ct.id)) {
      registerEdgeTypeSchema(ct);
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
    // T-131: thin reader over the plugin's tables for the consent route
    // + projection after-hooks. The plugin itself owns writes.
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
    // T-116: account-lifecycle store reads/writes auth_user's deletion
    // columns. Lives on the unwrapped base instance because the auth_*
    // tables are RLS-bypassed (better-auth manages its own context).
    accountLifecycle: new PgAccountLifecycleStore(baseDb),
    settings: new PgSettingsStore(db),
    coordination: new PgCoordinationStore(client),
    // T-218: async substrate for bulk_action. Wired on the wrapped
    // instance so RLS scopes its tenant_id reads/writes per request;
    // the worker runs outside a request and bypasses RLS via the
    // unwrapped path on `client.reserve()` — not needed in the store
    // class itself, only at the worker boundary.
    bulkActionJobs: new PgBulkActionJobStore(db),
    tenantQuotas: new PgTenantQuotaStore(db),
    // T-026: cluster-shared rate-limit + per-email throttle counters.
    // Wired on the wrapped instance so the request-context RLS proxy
    // doesn't bypass it; the rate-limit table is platform-internal
    // (no tenant_id column, no RLS policy) and the queries target
    // global counters by design.
    rateLimits: new PgRateLimitStore(db),
    // T-050: tenant store wired unconditionally — see sqlite index.ts
    // for rationale. The fan-out on tenant cleanup needs `tenants.list`
    // available regardless of authMode.
    tenants: new PgTenantStore(db),
    ...(options?.authMode === "hosted" && {
      users: new PgUserStore(db),
    }),
    /**
     * Genuinely transactional under postgres-js + ALS routing (T-160).
     * Opens a Drizzle transaction via `db.transaction(async tx => …)`
     * and installs `tx` on `pgRequestContext` so every store call inside
     * `fn` resolves its executor to the transaction via the proxy in
     * `request-context.ts`. All work inside `fn` runs on the
     * transaction's reserved connection; rollback is real on throw.
     *
     * Pre-T-160 this used `client.begin(async () => fn())` and discarded
     * the transaction-scoped query interface. Storage calls inside `fn`
     * fell through to the unwrapped base instance via the proxy (no ALS
     * context) and acquired SECOND pool connections per query, while the
     * `begin` connection sat `idle in transaction` waiting for queries
     * that never came. Under concurrent writes the pool saturated, every
     * `runInTransaction` callback blocked acquiring an inner connection,
     * and the server wedged for ~15 minutes until clients gave up.
     *
     * Goes through the wrapped `db`: when the caller is already inside
     * the RLS middleware's transaction (a tenant-scoped request), the
     * proxy resolves `transaction` against the existing `tx` and Drizzle
     * issues a SAVEPOINT — staying on the middleware's connection and
     * preserving RLS isolation. Outside a request (retention jobs,
     * single-tenant self-host), the proxy falls through to `baseDb` and
     * opens a fresh transaction on the owner connection. Either way the
     * inner work shares one pool slot, not two.
     */
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => {
        return await pgRequestContext.run({ tx }, async () => fn());
      });
    },
    deleteAccountCascade: (
      authUserId: string,
      cutoffIso: string,
    ): Promise<boolean> => {
      // The cascade runs on the unwrapped base instance: see the note
      // on `accountLifecycle` above — auth_* are RLS-bypassed and this
      // operation crosses tenant/auth boundaries by design.
      return pgDeleteAccountCascade(baseDb, storage, authUserId, cutoffIso);
    },
    close,
    /** Raw query escape hatch. Originally added for parameterised
     *  mutations in retention tests; now also consumed by
     *  `routes/auth-account.ts` (auth_verification probes via the
     *  better-auth-managed table) and `legacy-extension-check.ts`
     *  (T-140 boot probe — JSON operators not naturally expressible
     *  in Drizzle). Production callers exist; rename is a real
     *  blast-radius change. */
    __pgClient(query: string, params?: unknown[]): Promise<unknown[]> {
      return params
        ? client.unsafe(query, params as (string | number | boolean)[])
        : client.unsafe(query);
    },
    // Better Auth runs on the unwrapped base instance — its tables
    // (auth_user, auth_session, etc.) carry no RLS policies and the
    // auth library manages its own connection context outside the
    // per-request RLS middleware. T-025 part 2.
    betterAuthDb: baseDb,
    betterAuthDialect: "pg" as const,
    // T-025 part 2: the wrapped Drizzle instance, exposed so the
    // RLS middleware can drive `db.transaction(...)` directly to
    // wrap each tenant-bounded request.
    pgDb: db,
    // T-146: the underlying postgres-js client, exposed so streaming
    // routes (`/events`, `/export`) can `client.reserve()` a dedicated
    // pool connection for session-level RLS.
    pgClient: client,
  } satisfies Storage & {
    __pgClient(query: string, params?: unknown[]): Promise<unknown[]>;
    betterAuthDb: unknown;
    betterAuthDialect: "pg";
  };

  return storage;
}
