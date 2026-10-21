import type { AppConfig } from "../config.js";
import {
  BlobStoreUnreachable,
  DiskBlobStore,
  type BlobStore,
} from "./blob-store.js";
import { S3BlobStore } from "./blob-s3.js";
import type { Storage } from "./interface.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";
import { withBlobFaults } from "./blob-faults.js";
import { faultsArmed, storeCheckDeadlineFault } from "../control/faults.js";

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
 * in time rather than holding back the answer. Read the bound through
 * {@link storeCheckTimeoutMs}.
 */
export const storeChecks = { concurrency: 16, timeoutMs: 15_000 };

/** How long one question to a store may go unanswered: the bound in
 *  {@link storeChecks}, or the shorter one a `store-check-deadline` fault
 *  sets on a server with test hooks. */
export function storeCheckTimeoutMs(): number {
  return (
    (faultsArmed() ? storeCheckDeadlineFault() : undefined) ??
    storeChecks.timeoutMs
  );
}

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

/**
 * `work`, or a rejection once `ms` have passed without it settling or once
 * `signal` aborts. Either way the signal `work` was handed aborts, so the
 * store gives the request up, and an answer that comes after all is handed
 * to `late`, so a stream it opened is not left open. Past `ms` the rejection
 * is a {@link BlobStoreUnreachable}, whatever the store's own rejection to
 * the abort says: a store that does not answer is one that cannot be
 * reached, not one that holds no copy.
 */
export async function within<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  options: { signal?: AbortSignal; late?: (value: T) => void } = {},
): Promise<T> {
  const controller = new AbortController();
  const { signal: outer, late } = options;
  const stop = () => {
    controller.abort(outer?.reason);
  };
  if (outer?.aborted) stop();
  else outer?.addEventListener("abort", stop, { once: true });
  const silent = new BlobStoreUnreachable(`no answer within ${String(ms)} ms`);
  const timer = setTimeout(() => {
    controller.abort(silent);
  }, ms);
  const running = work(controller.signal);
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        const given = () => {
          reject(controller.signal.reason as Error);
        };
        if (controller.signal.aborted) given();
        else controller.signal.addEventListener("abort", given, { once: true });
      }),
    ]);
  } catch (error) {
    running.then(late ?? (() => undefined), () => undefined);
    if (controller.signal.reason === silent) throw silent;
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

/**
 * `stores` with those in `unanswered`, the ids of stores that failed or did
 * not answer earlier in the same piece of work, moved to the end. One
 * hanging store then costs the work one timeout, not one for each blob,
 * while a blob it alone holds is still asked of it.
 */
export function answeringFirst(
  stores: readonly BlobStore[],
  unanswered: ReadonlySet<string>,
): BlobStore[] {
  return [
    ...stores.filter((store) => !unanswered.has(store.id)),
    ...stores.filter((store) => unanswered.has(store.id)),
  ];
}

/**
 * For each blob in `sizes`, an attached store that the log records a copy
 * in and that holds the blob at its whole size, asked of the stores
 * themselves; `null` when none does. The stores are asked in the order
 * {@link answeringFirst} gives, the disk first otherwise, and a store that
 * fails or does not answer joins `unanswered`. The log is read once for the
 * lot.
 *
 * Throws `blob_store_unavailable` when no store holds a blob whole and a
 * store it asked failed or did not answer in time: a store that cannot
 * answer is not evidence that a copy is gone. The checks still running then
 * are called off.
 */
export async function wholeCopies(
  storage: Storage,
  blobs: BlobLayer,
  sizes: ReadonlyMap<string, number>,
  options: { signal?: AbortSignal; unanswered?: Set<string> } = {},
): Promise<Map<string, BlobStore | null>> {
  const { signal, unanswered = new Set<string>() } = options;
  const recorded = await storage.blobs.storeIdsOf([...sizes.keys()]);
  const found = new Map<string, BlobStore | null>();
  const queue = [...sizes];
  const decided = new AbortController();
  const stop = () => {
    decided.abort(signal?.reason);
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const check = async (hash: string, size: number) => {
    const ids = new Set(recorded.get(hash) ?? []);
    let failure: MarfaError | undefined;
    const holding = blobs.stores.filter((one) => ids.has(one.id));
    for (const store of answeringFirst(holding, unanswered)) {
      let held: { size_bytes: number } | null;
      try {
        held = await within(
          (cancel) => store.has(hash, cancel),
          storeCheckTimeoutMs(),
          { signal: decided.signal },
        );
      } catch (error) {
        decided.signal.throwIfAborted();
        unanswered.add(store.id);
        failure ??= storeUnavailable(store, hash, error);
        continue;
      }
      if (held?.size_bytes === size) return store;
    }
    if (failure) throw failure;
    return null;
  };
  const worker = async () => {
    for (
      let next = queue.shift();
      next && !decided.signal.aborted;
      next = queue.shift()
    ) {
      found.set(next[0], await check(next[0], next[1]));
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(storeChecks.concurrency, queue.length) },
        worker,
      ),
    );
  } finally {
    decided.abort();
    signal?.removeEventListener("abort", stop);
  }
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
  | "testHooks"
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
  if (config.testHooks) for (const store of stores) withBlobFaults(store);
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
