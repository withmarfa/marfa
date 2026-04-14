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
import { PgThreadStore } from "./thread-store.js";
import { PgTypeStore } from "./type-store.js";
import { PgSearchStore } from "./search-store.js";
import { PgKeyStore } from "./key-store.js";
import { PgBlobStore } from "./blob-store.js";
import { PgOAuthStore } from "./oauth-store.js";
import { PgWebhookStore } from "./webhook-store.js";
import { PgWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { PgAuditStore } from "./audit-store.js";
import { PgEventLogStore } from "./event-log-store.js";
import { PgUserStore } from "./user-store.js";
import { PgTenantStore } from "./tenant-store.js";
import { PgEdgeStore } from "./edge-store.js";
import { PgEdgeTypeStore } from "./edge-type-store.js";

export async function createPgStorage(
  connectionString: string,
  options?: {
    versionSnapshotIntervalMs?: number;
    authMode?: "hosted" | "keys";
  },
): Promise<Storage> {
  const { db, client, close } = await createConnection(connectionString);

  const versionStore = new PgVersionStore(db);
  const searchStore = new PgSearchStore(client);
  const itemStore = new PgItemStore(
    db,
    versionStore,
    searchStore,
    options?.versionSnapshotIntervalMs,
  );
  const metadataStore = new PgMetadataStore(db);
  const threadStore = new PgThreadStore(db);
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
  const auditStore = new PgAuditStore(db);
  const eventLogStore = new PgEventLogStore(db);
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
    threads: threadStore,
    types: typeStore,
    search: searchStore,
    keys: keyStore,
    blobs: blobStore,
    edges: edgeStore,
    edgeTypes: edgeTypeStore,
    oauth: oauthStore,
    webhooks: webhookStore,
    webhookDeliveries: deliveryStore,
    audit: auditStore,
    eventLog: eventLogStore,
    ...(options?.authMode === "hosted" && {
      users: new PgUserStore(db),
      tenants: new PgTenantStore(db),
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
      await client`TRUNCATE items, metadata, versions, threads, edges, api_keys, blobs, oauth_clients, oauth_grants, oauth_tokens, oauth_codes, webhooks, webhook_deliveries, audit_log, event_log, tenants, users CASCADE`;
    },
    /** Raw query escape hatch — used by the edge-backfill script. */
    __pgClient(query: string): Promise<unknown[]> {
      return client.unsafe(query);
    },
  } satisfies Storage & {
    _pgTruncate(): Promise<void>;
    __pgClient(query: string): Promise<unknown[]>;
  };

  return storage;
}
