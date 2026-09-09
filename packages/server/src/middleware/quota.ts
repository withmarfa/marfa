import type { Context } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { QuotaResource } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "./auth.js";

/**
 * Per-space quota enforcement.
 *
 * Reserve this write's quota. **Call it as the first statement inside the
 * transaction the write commits in**, and hold that transaction until the
 * write is done.
 *
 * A `(space, resource)` lock is taken on that transaction, then the count is
 * read under it, so the number already includes every write admitted ahead of
 * this one and no other writer of the same resource in the same space can
 * read a count that omits this write. A check that returned before the write
 * could not do that: N concurrent writers each read the same pre-write count,
 * each saw room, and the space settled at `limit + N - 1`.
 *
 * **The lock rides the caller's transaction; it must not bracket it.** A
 * lock released before the write commits leaves the next holder counting
 * rows that do not include it, which is the race this closes.
 * `withExclusiveLock` releases at the end of its callback rather than at
 * the caller's commit, so it cannot guard a write however it is pooled;
 * see `CoordinationStore.lockInTransaction`.
 *
 * **This does not open a transaction of its own**, deliberately. Wrapping the
 * caller would nest one transaction inside another where the caller already
 * has one, and would impose one where it does not — and a route holding a
 * transaction across work it did not previously is a real cost, not a
 * formality: SQLite admits a single writer, so a transaction taken around a
 * blob's physical write serialises against every other writer in the process
 * for as long as the bytes take to land.
 *
 * Multiple reservations lock in sorted resource order. Blob upload reserves
 * both `blobs` and `storage_bytes`, and two callers taking those in opposite
 * orders would deadlock against each other; a deterministic order is what
 * makes the second reservation safe to add.
 *
 * No-op for a caller with no space: the operator key, single-space self-hosts
 * and the bootstrap credential have no space to constrain. Also a no-op when
 * nothing is limited, so an unlimited space is never serialised against a
 * ceiling that does not exist — a NULL `<resource>_limit` on the space_quotas
 * row with no env default means unlimited.
 *
 * Counts stay computed on demand rather than eagerly incremented. The lock is
 * what makes an on-demand count correct, which is what an eager counter would
 * have been for, and it leaves no second source of truth to reconcile.
 */
export async function reserveQuota(
  c: Context<AppEnv>,
  storage: Storage,
  reservations: readonly { resource: QuotaResource; increment: number }[],
): Promise<void> {
  return reserveQuotaForSpace(
    storage,
    c.get("config"),
    c.get("apiKey")?.space_id,
    reservations,
  );
}

/**
 * The explicit-space form, for writes performed on a space's behalf by a
 * caller who has no space of their own. The context form above reads the
 * caller's `space_id`, which for the operator key is `undefined` — so an
 * operator-gated route calling it reserved nothing, silently, and archive
 * restore wrote whatever the archive contained. A route writing INTO a
 * space names that space here regardless of who is asking.
 */
export async function reserveQuotaForSpace(
  storage: Storage,
  config: AppConfig,
  spaceId: string | undefined,
  reservations: readonly { resource: QuotaResource; increment: number }[],
): Promise<void> {
  if (!spaceId || reservations.length === 0) return;

  const limits: {
    resource: QuotaResource;
    increment: number;
    limit: number;
  }[] = [];
  for (const r of reservations) {
    const limit = await effectiveLimit(storage, spaceId, r.resource, config);
    if (limit !== null) limits.push({ ...r, limit });
  }
  if (limits.length === 0) return;

  const ordered = [...limits].sort((a, b) =>
    a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0,
  );

  for (const r of ordered) {
    await storage.coordination.lockInTransaction(
      `quota:${spaceId}:${r.resource}`,
    );
  }
  // Every lock is held for the rest of the caller's transaction. Count now,
  // so the number includes every write already committed under the same lock.
  for (const r of ordered) {
    const current = await storage.spaceQuotas.count(spaceId, r.resource);
    if (current + r.increment > r.limit) {
      throw new MarfaError(
        ErrorCode.QUOTA_EXCEEDED,
        `Space quota for ${r.resource} exceeded`,
        { resource: r.resource, limit: r.limit, current },
      );
    }
  }
}

/** Returns null when no limit applies (unlimited). */
async function effectiveLimit(
  storage: Storage,
  spaceId: string,
  resource: QuotaResource,
  config: AppConfig,
): Promise<number | null> {
  const quota = await storage.spaceQuotas.get(spaceId);
  if (quota) {
    const spaceLimit = (() => {
      switch (resource) {
        case "items":
          return quota.items_limit;
        case "webhooks":
          return quota.webhooks_limit;
        case "blobs":
          return quota.blobs_limit;
        case "storage_bytes":
          return quota.storage_bytes_limit;
        case "rate_per_minute":
          return quota.rate_per_minute_limit;
      }
    })();
    if (spaceLimit !== null && spaceLimit !== undefined) return spaceLimit;
  }
  // Instance default — the env vars (`MARFA_DEFAULT_QUOTA_*`) are parsed
  // once in config.ts; consume those values rather than re-reading
  // `process.env` here, so a single config source stays authoritative.
  return configDefault(resource, config);
}

function configDefault(
  resource: QuotaResource,
  config: AppConfig,
): number | null {
  switch (resource) {
    case "items":
      return config.defaultQuotaItems ?? null;
    case "webhooks":
      return config.defaultQuotaWebhooks ?? null;
    case "blobs":
      return config.defaultQuotaBlobs ?? null;
    case "storage_bytes":
      return config.defaultQuotaStorageBytes ?? null;
    case "rate_per_minute":
      return config.defaultQuotaRatePerMinute ?? null;
  }
}
