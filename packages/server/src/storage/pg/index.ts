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

export async function createPgStorage(
  connectionString: string,
): Promise<Storage> {
  const { db, client, close } = await createConnection(connectionString);

  const versionStore = new PgVersionStore(db);
  const searchStore = new PgSearchStore(client);
  const itemStore = new PgItemStore(db, versionStore, searchStore);
  const metadataStore = new PgMetadataStore(db);
  const threadStore = new PgThreadStore(db);
  const typeStore = new PgTypeStore();
  const keyStore = new PgKeyStore(db);
  const blobStore = new PgBlobStore(db);

  const storage = {
    items: itemStore,
    metadata: metadataStore,
    versions: versionStore,
    threads: threadStore,
    types: typeStore,
    search: searchStore,
    keys: keyStore,
    blobs: blobStore,
    close,
    /** Truncate all tables — used by tests for isolation. */
    async _pgTruncate(): Promise<void> {
      await client`TRUNCATE items, metadata, versions, threads, api_keys, blobs CASCADE`;
    },
  };

  return storage;
}
