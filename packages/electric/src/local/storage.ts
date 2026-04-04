import { createLocalConnection } from "./connection.js";
import type { LocalDb, RawLocalDb } from "./connection.js";
import { LocalItemStore } from "./stores/item-store.js";
import { LocalMetadataStore } from "./stores/metadata-store.js";
import { LocalThreadStore } from "./stores/thread-store.js";

export interface LocalStorage {
  items: LocalItemStore;
  metadata: LocalMetadataStore;
  threads: LocalThreadStore;
  db: LocalDb;
  raw: RawLocalDb;
  close: () => void;
}

export function createLocalStorage(filePath: string): LocalStorage {
  const { db, raw, close } = createLocalConnection(filePath);

  return {
    items: new LocalItemStore(db),
    metadata: new LocalMetadataStore(db),
    threads: new LocalThreadStore(db),
    db,
    raw,
    close,
  };
}
