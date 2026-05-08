import {
  registerTypeSchema,
  isCoreType,
  registerEdgeTypeSchema,
  isCoreEdgeType,
} from "@mymehq/shared";
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
import { PgEmailSuppressionsStore } from "./email-suppressions-store.js";

export async function createPgStorage(
  connectionString: string,
  options?: {
    versionSnapshotIntervalMs?: number;
    authMode?: "hosted" | "keys";
  },
): Promise<Storage> {
  // `db` is the wrapped Drizzle instance (per-request RLS context aware);
  // `baseDb` is the raw owner-connection instance reserved for Better Auth.
  // T-025 part 2: see `request-context.ts` for the substitution mechanic.
  const { db, baseDb, client, close } =
    await createConnection(connectionString);

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
    outboundWebhooks: webhookStore,
    outboundWebhookDeliveries: deliveryStore,
    inboundWebhooks: inboundWebhookStore,
    inboundWebhookEvents: inboundWebhookEventStore,
    connectionOauthTokens: connectionOauthTokenStore,
    connectionLeasedTokens: connectionLeasedTokenStore,
    audit: auditStore,
    eventLog: eventLogStore,
    authSessions: authSessionStore,
    settings: new PgSettingsStore(db),
    coordination: new PgCoordinationStore(client),
    tenantQuotas: new PgTenantQuotaStore(db),
    emailSuppressions: new PgEmailSuppressionsStore(db),
    // T-050: tenant store wired unconditionally — see sqlite index.ts
    // for rationale. The fan-out on tenant cleanup needs `tenants.list`
    // available regardless of authMode.
    tenants: new PgTenantStore(db),
    ...(options?.authMode === "hosted" && {
      users: new PgUserStore(db),
    }),
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      let result: T | undefined;
      await client.begin(async () => {
        result = await fn();
      });
      return result as T;
    },
    close,
    /** Truncate all tables — used by tests for isolation. */
    async _pgTruncate(): Promise<void> {
      await client`TRUNCATE items, metadata, versions, edges, api_keys, blobs, oauth_clients, oauth_tokens, oauth_codes, oauth_device_codes, outbound_webhooks, outbound_webhook_deliveries, inbound_webhooks, inbound_webhook_events, connection_oauth_tokens, connection_leased_tokens, audit_log, event_log, tenants, tenant_quotas, email_suppressions, users, auth_user, auth_session, auth_account, auth_verification, auth_passkey CASCADE`;
    },
    /** Raw query escape hatch — used by retention tests for parameterised mutations. */
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
  } satisfies Storage & {
    _pgTruncate(): Promise<void>;
    __pgClient(query: string, params?: unknown[]): Promise<unknown[]>;
    betterAuthDb: unknown;
    betterAuthDialect: "pg";
  };

  return storage;
}
