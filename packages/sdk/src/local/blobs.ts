import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isValidBlobHash } from "@withmarfa/shared";
import type { MarfaClient } from "../client.js";
import { MarfaError } from "../errors.js";
import { classifyFailure } from "./classify.js";
// The drain's own budget, so a blob and the write it holds up do not run
// out at different times. Its import of this module is type-only and
// erased, and this is read inside the factory rather than at module load,
// so the pairing is not a runtime cycle.
import { DEFAULT_RETRY_CEILING } from "./drain.js";
import type { LocalStore } from "./store/index.js";

/**
 * How many bytes of downloaded blobs the store keeps.
 *
 * A default rather than a rule: an app that knows its own corpus should
 * set this. 256 MiB is chosen to be large enough that an ordinary
 * session's attachments survive it and small enough that a store cannot
 * quietly become the largest thing on a laptop.
 */
export const DEFAULT_BLOB_CACHE_BYTES = 256 * 1024 * 1024;

/** Where a store's blob bytes live: beside the store, named after it. */
export function defaultBlobDir(storePath: string): string {
  return `${storePath}.blobs`;
}

/** The `sha256:<hex>` name the server gives these bytes, computed here so
 *  the reference can be written before anything has been uploaded. */
export function hashBlob(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Every blob hash in a value tree.
 *
 * Recursive because a hash can sit anywhere a type puts a string —
 * `blob_ref` on a file item, an entry in an attachments array, a field a
 * custom type invented. Missing one means the write that names it does
 * not wait for its upload, which is the single failure this scanning
 * exists to prevent.
 */
export function collectBlobHashes(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (isValidBlobHash(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectBlobHashes(element, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectBlobHashes(nested, out);
    }
  }
}

/** A blob the server refused for good. Its bytes are still on disk. */
export interface BlobRefusal {
  hash: string;
  code: string | null;
  httpStatus: number | null;
  message: string;
}

export interface BlobFlushResult {
  /** Hashes the server now holds. */
  uploaded: string[];
  /** Refusals. The caller dead-letters whatever writes name them. */
  refused: BlobRefusal[];
  /** The pass stopped because the server could not be reached. */
  offline: boolean;
  /** The credential is spent, with the message that said so. */
  auth: string | undefined;
}

export interface LocalBlobs {
  /**
   * Write bytes beside the store and queue their upload.
   *
   * Returns the hash immediately, because the reference is what the write
   * carries and the write is what a person just made. Nothing has reached
   * a server and nothing needs to have.
   */
  stage(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ hash: string; size: number }>;
  /** Bytes for a hash: from disk when they are there, from the server
   *  otherwise, and cached on the way through. */
  read(hash: string): Promise<Uint8Array>;
  /** Send everything queued, in the order it was staged. One pass. */
  flush(): Promise<BlobFlushResult>;
  /**
   * Drop a staged blob and its bytes.
   *
   * The only way retained bytes leave, and deliberately the app's call
   * rather than the engine's: the bytes behind a refused upload are the
   * copy a person still has, and the engine has no business deciding they
   * are finished with it.
   */
  discard(hash: string): Promise<boolean>;
  /** Where the bytes for a hash would be. */
  pathFor(hash: string): string;
  /** Whether the bytes are on disk right now. */
  held(hash: string): boolean;
}

export interface BlobStoreOptions {
  store: LocalStore;
  client: MarfaClient;
  /** Where the bytes go. Defaults to {@link defaultBlobDir} of the store's
   *  own path. */
  dir?: string;
  /** Ceiling on downloaded bytes kept. See {@link DEFAULT_BLOB_CACHE_BYTES}. */
  maxCacheBytes?: number;
  /**
   * Attempts an upload gets before the bytes are handed back as refused.
   * Defaults to {@link DEFAULT_RETRY_CEILING}, the same budget a mutation
   * gets, because a blob that never lands holds a write behind it and the
   * two should not run out at different times.
   */
  retryCeiling?: number;
  now?: () => string;
}

/** A blob upload is a POST that repeats safely on its content hash, which
 *  is how a create behaves, so the create's reading of each status is the
 *  right one here. */
const UPLOAD_AS: Parameters<typeof classifyFailure>[1] = "item.create";

/**
 * Whether a refusal of these bytes is one no retry changes.
 *
 * `classifyFailure` implements the contract's closed classification, which
 * is written about mutations: it lists 400, 403, 404 and the schema codes
 * as permanent and everything else as something to wait out. A blob upload
 * meets one refusal that list does not name — the payload is over the
 * server's ceiling — and waiting does not make the bytes smaller. Read as
 * transient it would be re-sent to the retry ceiling and then park the
 * write behind it with `retry_ceiling` as the reason, which tells a person
 * nothing about a file that is simply too big.
 *
 * Answered here rather than by widening `classifyFailure`, because that
 * function is the contract's classification for mutations and a blob is
 * not one.
 */
function refusedForGood(error: unknown): boolean {
  return error instanceof MarfaError && error.status === 413;
}

export function createBlobStore(options: BlobStoreOptions): LocalBlobs {
  const { store, client } = options;
  const uploadCeiling = options.retryCeiling ?? DEFAULT_RETRY_CEILING;
  const dir = options.dir ?? defaultBlobDir(store.path);
  const ceiling = options.maxCacheBytes ?? DEFAULT_BLOB_CACHE_BYTES;
  const now = options.now ?? (() => new Date().toISOString());

  /** The hex half, which is a safe filename where the hash is not. */
  const fileFor = (hash: string): string =>
    join(dir, hash.replace(/^sha256:/, ""));

  const ensureDir = (): void => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  };

  /**
   * Bring the cache back under its ceiling.
   *
   * **The eviction rule, stated: the cache is bounded by total bytes on
   * disk, and a write that takes it past the ceiling evicts the least
   * recently read cached blobs until it fits.** Only downloaded blobs are
   * ever candidates. Bytes staged for upload are excluded because they are
   * the only copy that exists anywhere — evicting one loses a person's
   * attachment, which is the outcome rule 14 exists to prevent — and that
   * exclusion is structural rather than a condition written here: staged
   * bytes have no row in the cache table at all, so this walk cannot reach
   * them.
   *
   * A single blob larger than the whole ceiling is never cached, and that
   * is a separate arm rather than an emergent property: without it, this
   * loop would evict every other blob and still not fit, so one oversized
   * read would empty the cache and then be evicted itself.
   */
  const evictToFit = async (): Promise<void> => {
    let total = await store.blobs.cache.totalBytes();
    if (total <= ceiling) return;
    for (const candidate of await store.blobs.cache.listByAge()) {
      if (total <= ceiling) return;
      await store.blobs.cache.remove(candidate.hash);
      rmSync(fileFor(candidate.hash), { force: true });
      total -= candidate.size;
    }
  };

  const cacheBytes = async (
    hash: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<void> => {
    if (bytes.byteLength > ceiling) return;
    ensureDir();
    writeFileSync(fileFor(hash), bytes);
    await store.blobs.cache.put({
      hash,
      mimeType,
      size: bytes.byteLength,
      now: now(),
    });
    await evictToFit();
  };

  return {
    pathFor: fileFor,

    held: (hash) => existsSync(fileFor(hash)),

    stage: async (bytes, mimeType) => {
      const hash = hashBlob(bytes);
      ensureDir();
      // Bytes before the row, so a crash between them leaves a file with
      // nothing pointing at it rather than a queue entry whose bytes are
      // not there. The first is a wasted file the next stage of the same
      // content overwrites; the second is an upload that can never
      // succeed.
      writeFileSync(fileFor(hash), bytes);
      await store.blobs.stage({
        hash,
        mimeType,
        size: bytes.byteLength,
        now: now(),
      });
      return { hash, size: bytes.byteLength };
    },

    read: async (hash) => {
      const path = fileFor(hash);
      if (existsSync(path)) {
        // Read-through, so a hit still counts as a read: eviction orders by
        // last read, and a cache that never recorded one would evict by age
        // of arrival and drop exactly the blobs an app keeps asking for.
        if ((await store.blobs.cache.get(hash)) !== undefined) {
          await store.blobs.cache.touch(hash, now());
        }
        return new Uint8Array(readFileSync(path));
      }
      const downloaded = new Uint8Array(await client.blobs.download(hash));
      await cacheBytes(hash, downloaded, "application/octet-stream");
      return downloaded;
    },

    flush: async () => {
      const uploaded: string[] = [];
      const refused: BlobRefusal[] = [];

      for (const blob of await store.blobs.listPending()) {
        const path = fileFor(blob.hash);
        if (!existsSync(path)) {
          // Nothing to send and nothing that can be sent later. Recorded as
          // a refusal so the writes that name it are dead-lettered with a
          // reason rather than held for ever behind an upload that cannot
          // happen.
          const message = `@withmarfa/sdk/local: the bytes for ${blob.hash} are not on disk, so the upload cannot be made`;
          await store.blobs.fail(
            blob.hash,
            "blob_bytes_missing",
            message,
            now(),
          );
          refused.push({
            hash: blob.hash,
            code: "blob_bytes_missing",
            httpStatus: null,
            message,
          });
          continue;
        }

        // The probe, on replay only. A first attempt has nothing to ask
        // about; an attempt after one that did not come back has exactly
        // the question this answers — the request may have been served and
        // the answer lost, and re-uploading blindly would send the bytes
        // again for nothing. It also tells "already there" from "lost",
        // which is the distinction rule 14 names: a HEAD that says no
        // means the upload really did not land and the bytes are still
        // owed.
        if (blob.attempts > 0) {
          try {
            if (await client.blobs.exists(blob.hash)) {
              await store.blobs.settle(blob.hash);
              await store.blobs.cache.put({
                hash: blob.hash,
                mimeType: blob.mimeType,
                size: blob.size,
                now: now(),
              });
              await evictToFit();
              uploaded.push(blob.hash);
              continue;
            }
          } catch (probeError) {
            const verdict = classifyFailure(probeError, UPLOAD_AS);
            if (verdict.class === "offline") {
              return { uploaded, refused, offline: true, auth: undefined };
            }
            if (verdict.class === "auth") {
              return {
                uploaded,
                refused,
                offline: false,
                auth: verdict.message,
              };
            }
            // Anything else and the probe has told us nothing, so the
            // upload below answers the question instead.
          }
        }

        try {
          const bytes = new Uint8Array(readFileSync(path));
          await client.blobs.upload(bytes, blob.mimeType);
          await store.blobs.settle(blob.hash);
          // The bytes are already on disk and the server now has them too,
          // so they become an ordinary cached copy — evictable, unlike the
          // moment before, when they were the only copy anywhere.
          await store.blobs.cache.put({
            hash: blob.hash,
            mimeType: blob.mimeType,
            size: blob.size,
            now: now(),
          });
          await evictToFit();
          uploaded.push(blob.hash);
        } catch (uploadError) {
          if (refusedForGood(uploadError)) {
            const refusal = uploadError as MarfaError;
            await store.blobs.fail(
              blob.hash,
              refusal.code,
              refusal.message,
              now(),
            );
            refused.push({
              hash: blob.hash,
              code: refusal.code,
              httpStatus: refusal.status,
              message: refusal.message,
            });
            continue;
          }
          const verdict = classifyFailure(uploadError, UPLOAD_AS);
          switch (verdict.class) {
            case "offline":
              // Recorded even though nothing was refused, and that is the
              // difference between a blob and a mutation. For a mutation an
              // offline pass is not an attempt, because attempts are a
              // retry budget. Here the count answers a different question:
              // whether a request for these bytes has ever gone out. It
              // has, and the client cannot tell a request that never
              // arrived from one that was served and whose answer was lost
              // — which is exactly what the probe on the next pass is for.
              await store.blobs.recordAttempt(
                blob.hash,
                verdict.message,
                now(),
              );
              return { uploaded, refused, offline: true, auth: undefined };
            case "auth":
              return {
                uploaded,
                refused,
                offline: false,
                auth: verdict.message,
              };
            case "transient":
            case "blocked":
            case "conflict": {
              await store.blobs.recordAttempt(
                blob.hash,
                verdict.message,
                now(),
              );
              // Rule 5 in terms: no row retries for ever without saying
              // why. Without this a blob meeting a quota, a suspension, a
              // rate limit or any 5xx retried on every pass for the life
              // of the store, while the write naming it sat as
              // `awaitingUpload`, counted among the pending, with nothing
              // emitted and no state that could say so.
              //
              // The refusal it is handed back with is the server's own
              // rather than a bare "ran out of retries", because that is
              // the sentence a person can act on — the bytes are still
              // here, and what is wrong is a quota or an outage they can
              // see named.
              if (blob.attempts + 1 >= uploadCeiling) {
                await store.blobs.fail(
                  blob.hash,
                  verdict.class === "blocked" ? verdict.reason : verdict.class,
                  verdict.message,
                  now(),
                );
                refused.push({
                  hash: blob.hash,
                  code:
                    verdict.class === "blocked"
                      ? verdict.reason
                      : verdict.class,
                  httpStatus: 0,
                  message: verdict.message,
                });
              }
              break;
            }
            // A blob has no type and no schema, so the schema arm cannot
            // describe one: a 400 here is the server refusing these bytes,
            // and no registry refresh changes that.
            case "schema":
            case "permanent": {
              // The row stays and so do the bytes. Losing a person's
              // attachment because an upload was refused is the outcome
              // rule 14 exists to prevent, so the refusal reaches them as
              // a dead letter with the file still in hand.
              await store.blobs.fail(
                blob.hash,
                verdict.code,
                verdict.message,
                now(),
              );
              refused.push({
                hash: blob.hash,
                code: verdict.code,
                httpStatus: verdict.httpStatus,
                message: verdict.message,
              });
              break;
            }
          }
        }
      }

      return { uploaded, refused, offline: false, auth: undefined };
    },

    discard: async (hash) => {
      const held = await store.blobs.get(hash);
      await store.blobs.forget(hash);
      await store.blobs.cache.remove(hash);
      rmSync(fileFor(hash), { force: true });
      return held !== undefined;
    },
  };
}
