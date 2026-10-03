import type { AppConfig } from "../config.js";
import { DiskBlobStore, type BlobStore } from "./blob-store.js";
import { S3BlobStore } from "./blob-s3.js";
import type { Storage } from "./interface.js";
import { runAuditedTransaction } from "./audited-transaction.js";

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

export type BlobLayerConfig = Pick<
  AppConfig,
  | "blobPath"
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
  const disk = new DiskBlobStore(config.blobPath);
  const s3 = config.s3Bucket
    ? new S3BlobStore({
        bucket: config.s3Bucket,
        region: config.s3Region,
        endpoint: config.s3Endpoint || undefined,
        accessKeyId: config.s3AccessKeyId || undefined,
        secretAccessKey: config.s3SecretAccessKey || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        prefix: config.s3Prefix,
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
