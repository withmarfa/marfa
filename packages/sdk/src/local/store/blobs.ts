import { asc, eq, sql } from "drizzle-orm";
import type { Executor } from "./executor.js";
import { blobCache, pendingBlobs } from "./schema.js";

/** Where a staged blob is in its life. A row leaves the queue when it
 *  lands; `failed` is a refusal whose bytes are being kept. */
export type PendingBlobState = "pending" | "failed";

export interface PendingBlob {
  /** `sha256:<hex>`. */
  hash: string;
  mimeType: string;
  size: number;
  state: PendingBlobState;
  attempts: number;
  /** The server's code, when one refused it. */
  code: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CachedBlob {
  hash: string;
  mimeType: string;
  size: number;
  lastReadAt: string;
  createdAt: string;
}

/**
 * The two blob tables, as rows.
 *
 * Bytes are not this layer's business — they live on disk beside the
 * store and `blobs.ts` in the parent directory owns them. Kept apart so
 * a transaction over the queue is a transaction over the queue, and the
 * filesystem, which has no transaction, is never inside one.
 */
export interface BlobLayer {
  /** Record a staged blob. Idempotent on the hash: the same bytes staged
   *  twice are one blob, which is what content addressing means. */
  stage(input: {
    hash: string;
    mimeType: string;
    size: number;
    now: string;
  }): Promise<void>;
  get(hash: string): Promise<PendingBlob | undefined>;
  /** Everything still owed to the server, oldest first. */
  listPending(): Promise<PendingBlob[]>;
  /** Everything, including refusals whose bytes are being kept. */
  listQueued(): Promise<PendingBlob[]>;
  /** The upload landed. The row leaves the queue; the bytes graduate to
   *  the cache, which is the caller's next call. */
  settle(hash: string): Promise<void>;
  recordAttempt(hash: string, error: string, now: string): Promise<void>;
  /** Refused for good. The row stays and so do the bytes. */
  fail(
    hash: string,
    code: string | null,
    error: string,
    now: string,
  ): Promise<void>;
  /** Forget a staged blob entirely. The app's call, once a person has
   *  read the dead letter and let it go. */
  forget(hash: string): Promise<void>;

  cache: {
    get(hash: string): Promise<CachedBlob | undefined>;
    put(input: {
      hash: string;
      mimeType: string;
      size: number;
      now: string;
    }): Promise<void>;
    touch(hash: string, now: string): Promise<void>;
    remove(hash: string): Promise<void>;
    /** Total bytes held, which is what the eviction rule is stated in. */
    totalBytes(): Promise<number>;
    /** Least recently read first, which is the order eviction walks. */
    listByAge(): Promise<CachedBlob[]>;
  };
}

export function createBlobLayer(exec: Executor): BlobLayer {
  const selectPending = () =>
    exec
      .select({
        hash: pendingBlobs.hash,
        mimeType: pendingBlobs.mimeType,
        size: pendingBlobs.size,
        state: pendingBlobs.state,
        attempts: pendingBlobs.attempts,
        code: pendingBlobs.code,
        lastError: pendingBlobs.lastError,
        createdAt: pendingBlobs.createdAt,
        updatedAt: pendingBlobs.updatedAt,
      })
      .from(pendingBlobs);

  const toPending = (row: {
    hash: string;
    mimeType: string;
    size: number;
    state: string;
    attempts: number;
    code: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }): PendingBlob => ({ ...row, state: row.state as PendingBlobState });

  const selectCache = () =>
    exec
      .select({
        hash: blobCache.hash,
        mimeType: blobCache.mimeType,
        size: blobCache.size,
        lastReadAt: blobCache.lastReadAt,
        createdAt: blobCache.createdAt,
      })
      .from(blobCache);

  return {
    stage: async ({ hash, mimeType, size, now }) => {
      await exec
        .insert(pendingBlobs)
        .values({
          hash,
          mimeType,
          size,
          state: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        })
        // The same bytes staged twice are the same blob. Re-staging clears
        // a previous refusal deliberately: a person who attaches the file
        // again is asking for it to be tried again, and leaving the row
        // `failed` would hold every write that names it with no way out.
        .onConflictDoUpdate({
          target: pendingBlobs.hash,
          set: {
            mimeType,
            size,
            state: "pending",
            attempts: 0,
            code: null,
            lastError: null,
            updatedAt: now,
          },
        });
    },

    get: async (hash) => {
      const rows = await selectPending().where(eq(pendingBlobs.hash, hash));
      const row = rows[0];
      return row === undefined ? undefined : toPending(row);
    },

    listPending: async () =>
      (
        await selectPending()
          .where(eq(pendingBlobs.state, "pending"))
          .orderBy(asc(pendingBlobs.createdAt), asc(pendingBlobs.hash))
      ).map(toPending),

    listQueued: async () =>
      (
        await selectPending().orderBy(
          asc(pendingBlobs.createdAt),
          asc(pendingBlobs.hash),
        )
      ).map(toPending),

    settle: async (hash) => {
      await exec.delete(pendingBlobs).where(eq(pendingBlobs.hash, hash));
    },

    recordAttempt: async (hash, error, now) => {
      await exec
        .update(pendingBlobs)
        .set({
          attempts: sql`${pendingBlobs.attempts} + 1`,
          lastError: error,
          updatedAt: now,
        })
        .where(eq(pendingBlobs.hash, hash));
    },

    fail: async (hash, code, error, now) => {
      await exec
        .update(pendingBlobs)
        .set({ state: "failed", code, lastError: error, updatedAt: now })
        .where(eq(pendingBlobs.hash, hash));
    },

    forget: async (hash) => {
      await exec.delete(pendingBlobs).where(eq(pendingBlobs.hash, hash));
    },

    cache: {
      get: async (hash) => {
        const rows = await selectCache().where(eq(blobCache.hash, hash));
        return rows[0];
      },

      put: async ({ hash, mimeType, size, now }) => {
        await exec
          .insert(blobCache)
          .values({
            hash,
            mimeType,
            size,
            lastReadAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: blobCache.hash,
            set: { mimeType, size, lastReadAt: now },
          });
      },

      touch: async (hash, now) => {
        await exec
          .update(blobCache)
          .set({ lastReadAt: now })
          .where(eq(blobCache.hash, hash));
      },

      remove: async (hash) => {
        await exec.delete(blobCache).where(eq(blobCache.hash, hash));
      },

      totalBytes: async () => {
        const rows = await exec
          .select({ total: sql<number>`coalesce(sum(${blobCache.size}), 0)` })
          .from(blobCache);
        return rows[0]?.total ?? 0;
      },

      listByAge: async () =>
        selectCache().orderBy(asc(blobCache.lastReadAt), asc(blobCache.hash)),
    },
  };
}
