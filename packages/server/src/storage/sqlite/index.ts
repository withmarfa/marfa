import type { Storage } from "../interface.js";
import { createConnection } from "./connection.js";
import { SqliteItemStore } from "./item-store.js";
import { SqliteMetadataStore } from "./metadata-store.js";
import { SqliteVersionStore } from "./version-store.js";
import { SqliteThreadStore } from "./thread-store.js";
import { SqliteTypeStore } from "./type-store.js";
import { SqliteSearchStore } from "./search-store.js";
import { SqliteKeyStore } from "./key-store.js";
import { SqliteBlobStore } from "./blob-store.js";
import { SqliteOAuthStore } from "./oauth-store.js";

export function createSqliteStorage(sqlitePath: string): Storage {
  const { db, raw, close } = createConnection(sqlitePath);

  const versionStore = new SqliteVersionStore(db);
  const searchStore = new SqliteSearchStore(raw);
  const itemStore = new SqliteItemStore(db, raw, versionStore, searchStore);
  const metadataStore = new SqliteMetadataStore(db);
  const threadStore = new SqliteThreadStore(db);
  const typeStore = new SqliteTypeStore();
  const keyStore = new SqliteKeyStore(db);
  const blobStore = new SqliteBlobStore(db);
  const oauthStore = new SqliteOAuthStore(db);

  return {
    items: itemStore,
    metadata: metadataStore,
    versions: versionStore,
    threads: threadStore,
    types: typeStore,
    search: searchStore,
    keys: keyStore,
    blobs: blobStore,
    oauth: oauthStore,
    close() {
      close();
      return Promise.resolve();
    },
  };
}
