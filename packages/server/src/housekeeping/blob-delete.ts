import type { BlobStore } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";

/**
 * The one place bytes leave a store. Every deletion reads the location log
 * first, because the copy rules are written over the log: a drop counts
 * the live copies that would remain, and a purge takes a blob to zero only
 * because the orphan report named it on an earlier run. No other module
 * calls a store's `delete`.
 */
export interface Stores {
  readonly stores: readonly BlobStore[];
  byId(id: string): BlobStore | undefined;
}

export class CopiesBelowMinimum extends Error {
  constructor(
    readonly hash: string,
    readonly live: number,
    readonly minCopies: number,
  ) {
    super(
      `dropping a copy of ${hash} would leave ${String(live - 1)} live copies, below the minimum of ${String(minCopies)}`,
    );
    this.name = "CopiesBelowMinimum";
  }
}

export class LocationNotFound extends Error {
  constructor(
    readonly hash: string,
    readonly storeId: string,
  ) {
    super(`no attached store ${storeId} holds a copy of ${hash}`);
    this.name = "LocationNotFound";
  }
}

/**
 * Drop one store's copy of a blob, when the log says enough live copies
 * would remain. The row goes before the bytes: a row without bytes is what
 * the integrity check strikes and replication mends, while bytes without a
 * row are what nothing sweeps.
 */
export async function dropBlobCopy(
  storage: Storage,
  stores: Stores,
  hash: string,
  storeId: string,
  minCopies: number,
): Promise<void> {
  const store = stores.byId(storeId);
  const locations = await storage.blobs.listLocations(hash);
  const held = locations.some(
    (location) => location.store_id === storeId && !location.detached,
  );
  if (!store || !held) throw new LocationNotFound(hash, storeId);
  const live = locations.filter((location) => !location.detached).length;
  if (live - 1 < minCopies) {
    throw new CopiesBelowMinimum(hash, live, minCopies);
  }
  await storage.blobs.removeLocation(hash, storeId);
  await store.delete(hash);
}

/**
 * Take a blob the orphan report named to zero: every attached store, the
 * log's rows and the report's row (both by cascade), then the registry.
 * Every attached store rather than the ones the log names, because a copy
 * the log did not know about would otherwise outlive its row.
 */
export async function purgeBlob(
  storage: Storage,
  stores: Stores,
  hash: string,
): Promise<void> {
  for (const store of stores.stores) {
    await store.delete(hash);
  }
  await storage.blobs.remove(hash);
}

/**
 * The second half of a strike: the bytes under a name they do not hash to.
 * The integrity check has already removed the row; what is left in the
 * store would otherwise be found in place by replication's `put`, which
 * treats bytes already under a name as that blob, and the good copy would
 * never land.
 */
export async function discardStruckCopy(
  store: BlobStore,
  hash: string,
): Promise<void> {
  await store.delete(hash);
}
