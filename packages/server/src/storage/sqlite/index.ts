import type { Storage } from "../interface.js";
import { createConnection } from "./connection.js";
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
import { SqliteAuditStore } from "./audit-store.js";
import { SqliteEventLogStore } from "./event-log-store.js";
import { SqliteUserStore } from "./user-store.js";
import { SqliteTenantStore } from "./tenant-store.js";
import { SqliteEdgeStore } from "./edge-store.js";
import { SqliteEdgeTypeStore } from "./edge-type-store.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { SqliteCoordinationStore } from "./coordination-store.js";
import { registerEdgeTypeSchema, isCoreEdgeType } from "@mymehq/shared";

export function createSqliteStorage(
  sqlitePath: string,
  options?: {
    versionSnapshotIntervalMs?: number;
    authMode?: "hosted" | "keys";
  },
): Storage & {
  __sqliteAll(query: string): unknown[];
  __sqliteRun(query: string, params: unknown[]): { changes: number };
  /** Drizzle handle exposed for the better-auth integration; not part
   *  of the public Storage contract. Consumed only by `auth/instance.ts`. */
  __betterAuthDb: unknown;
  __betterAuthDialect: "sqlite";
} {
  const { db, raw, close } = createConnection(sqlitePath);

  const versionStore = new SqliteVersionStore(db);
  const searchStore = new SqliteSearchStore(raw);
  const itemStore = new SqliteItemStore(
    db,
    raw,
    versionStore,
    searchStore,
    options?.versionSnapshotIntervalMs,
  );
  const metadataStore = new SqliteMetadataStore(db, raw);
  const typeStore = new SqliteTypeStore(db, raw);
  const keyStore = new SqliteKeyStore(db);
  const blobStore = new SqliteBlobStore(db);
  const oauthStore = new SqliteOAuthStore(db);
  const webhookStore = new SqliteWebhookStore(db);
  const deliveryStore = new SqliteWebhookDeliveryStore(db);
  const inboundWebhookStore = new SqliteInboundWebhookStore(db);
  const inboundWebhookEventStore = new SqliteInboundWebhookEventStore(db);
  const connectionOauthTokenStore = new SqliteConnectionOAuthTokenStore(db);
  const auditStore = new SqliteAuditStore(db);
  const eventLogStore = new SqliteEventLogStore(db, raw);
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

  return {
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
    audit: auditStore,
    eventLog: eventLogStore,
    settings: new SqliteSettingsStore(db),
    coordination: new SqliteCoordinationStore(),
    ...(options?.authMode === "hosted" && {
      users: new SqliteUserStore(db),
      tenants: new SqliteTenantStore(db),
    }),
    async runInTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      // better-sqlite3 transactions are synchronous. For sync callbacks,
      // wrapping in a transaction gives a ~100x speedup on bulk inserts.
      // For async callbacks, we run without a transaction wrapper since
      // better-sqlite3 doesn't support async transactions.
      return fn();
    },
    __betterAuthDb: db,
    __betterAuthDialect: "sqlite" as const,
    /** Raw query escape hatch — used by retention tests. */
    __sqliteAll(query: string): unknown[] {
      return raw.prepare(query).all();
    },
    /** Parameterised raw mutation escape hatch — used by retention tests
     *  that need to plant non-default `updated_at` values. */
    __sqliteRun(query: string, params: unknown[]): { changes: number } {
      const result = raw.prepare(query).run(...params) as { changes: number };
      return { changes: result.changes };
    },
    close() {
      close();
      return Promise.resolve();
    },
  };
}
