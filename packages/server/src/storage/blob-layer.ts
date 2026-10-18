import type { AppConfig } from "../config.js";
import { DiskBlobStore, type BlobStore } from "./blob-store.js";
import { S3BlobStore } from "./blob-s3.js";
import type { Storage } from "./interface.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";

/**
 * The stores this instance has attached, built in one place so that every
 * caller that boots an app has stores with ids and rows. A store that was
 * constructed and never attached has no id, records no location and would
 * make the log lie by omission.
 */
export interface BlobLayer {
  /** Always present: where an upload lands, and the spool it lands through. */
  readonly disk: DiskBlobStore;
  /** Present when `S3_BUCKET` is set. */
  readonly s3: S3BlobStore | null;
  /** Every attached store, the disk first. */
  readonly stores: readonly BlobStore[];
  byId(id: string): BlobStore | undefined;
}

/**
 * The attached stores the location log records a copy of `hash` in, the disk
 * first. A copy struck or dropped can linger in its store until its deletion
 * is retried, and those bytes are not the blob's.
 */
export async function recordedStores(
  storage: Storage,
  blobs: BlobLayer,
  hash: string,
): Promise<BlobStore[]> {
  const holding = new Set(
    (await storage.blobs.listLocations(hash)).map((l) => l.store_id),
  );
  return blobs.stores.filter((store) => holding.has(store.id));
}

/**
 * How a page of blobs has its copies checked: a few checks at a time, and
 * each given up after a bound, so a slow or hanging store answers a refusal
 * in time rather than holding back the answer.
 */
export const storeChecks = { concurrency: 16, timeoutMs: 15_000 };

/** The refusal for a store that failed or did not answer, which proves
 *  nothing about the copy it was asked for. */
export function storeUnavailable(
  store: BlobStore,
  hash: string,
  cause: unknown,
): MarfaError {
  log("error", "blob.store_unavailable", {
    hash,
    store_id: store.id,
    kind: store.kind,
    error: errorMessage(cause),
  });
  return new MarfaError(
    ErrorCode.BLOB_STORE_UNAVAILABLE,
    `The ${store.kind} store did not answer for a blob's copy. Retry later.`,
    { store_id: store.id },
  );
}

/** `work`, or a rejection once `ms` have passed without it settling. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For each blob in `sizes`, the first attached store, the disk first, that
 * the log records a copy in and that holds the blob at its whole size, asked
 * of the stores themselves; `null` when none does. The log is read once for
 * the lot.
 *
 * Throws `blob_store_unavailable` when a store it asks fails or does not
 * answer in time: a store that cannot answer is not evidence that a copy is
 * gone.
 */
export async function wholeCopies(
  storage: Storage,
  blobs: BlobLayer,
  sizes: ReadonlyMap<string, number>,
): Promise<Map<string, BlobStore | null>> {
  const recorded = await storage.blobs.storeIdsOf([...sizes.keys()]);
  const found = new Map<string, BlobStore | null>();
  const queue = [...sizes];
  let failed = false;
  const check = async (hash: string, size: number) => {
    const ids = new Set(recorded.get(hash) ?? []);
    for (const store of blobs.stores.filter((one) => ids.has(one.id))) {
      let held: { size_bytes: number } | null;
      try {
        held = await within(store.has(hash), storeChecks.timeoutMs);
      } catch (error) {
        throw storeUnavailable(store, hash, error);
      }
      if (held?.size_bytes === size) return store;
    }
    return null;
  };
  const worker = async () => {
    for (let next = queue.shift(); next && !failed; next = queue.shift()) {
      try {
        found.set(next[0], await check(next[0], next[1]));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(storeChecks.concurrency, queue.length) },
      worker,
    ),
  );
  return found;
}

export type BlobLayerConfig = Pick<
  AppConfig,
  | "blobPath"
  | "blobReadIdleTimeoutMs"
  | "s3Bucket"
  | "s3Region"
  | "s3Endpoint"
  | "s3AccessKeyId"
  | "s3SecretAccessKey"
  | "s3ForcePathStyle"
  | "s3Prefix"
>;

export async function createBlobLayer(
  storage: Storage,
  config: BlobLayerConfig,
): Promise<BlobLayer> {
  const disk = new DiskBlobStore(config.blobPath, config.blobReadIdleTimeoutMs);
  const s3 = config.s3Bucket
    ? new S3BlobStore({
        bucket: config.s3Bucket,
        region: config.s3Region,
        endpoint: config.s3Endpoint || undefined,
        accessKeyId: config.s3AccessKeyId || undefined,
        secretAccessKey: config.s3SecretAccessKey || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        prefix: config.s3Prefix,
        readIdleTimeoutMs: config.blobReadIdleTimeoutMs,
      })
    : null;
  const stores: BlobStore[] = s3 ? [disk, s3] : [disk];
  // Marker creation and remote store discovery cannot be rolled back by SQL.
  // Finish both before claiming any registry change.
  for (const store of stores) await store.attach();
  await runAuditedTransaction(
    storage,
    async () => {
      const existing = await storage.blobs.listStores();
      const byId = new Map(existing.map((store) => [store.id, store]));
      const configuredIds = new Set(stores.map((store) => store.id));
      const attached: string[] = [];
      const updated: string[] = [];
      for (const store of stores) {
        const prior = byId.get(store.id);
        if (
          prior?.detached_at === null &&
          prior.kind === store.kind &&
          prior.locator === store.locator
        )
          continue;
        await storage.blobs.attachStore({
          id: store.id,
          kind: store.kind,
          locator: store.locator,
        });
        (prior?.detached_at === null ? updated : attached).push(store.id);
      }
      const detached = existing
        .filter(
          (store) => store.detached_at === null && !configuredIds.has(store.id),
        )
        .map((store) => store.id);
      if (detached.length > 0)
        await storage.blobs.detachStoresExcept([...configuredIds]);
      return { attached, updated, detached };
    },
    (changes) =>
      Object.values(changes).some((ids) => ids.length > 0)
        ? {
            action: "blob.stores_configured",
            resource_type: "blob_store",
            client_ip: null,
            details: changes,
          }
        : null,
  );
  const byId = new Map(stores.map((store) => [store.id, store] as const));
  return {
    disk,
    s3,
    stores,
    byId: (id) => byId.get(id),
  };
}
