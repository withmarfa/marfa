/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
import { eq, sql } from "drizzle-orm";
import type { SpaceQuota, QuotaResource } from "@withmarfa/shared";
import type { SpaceQuotaStore } from "../interface.js";
import {
  spaceQuotas,
  spaces,
  items,
  outboundWebhooks,
  blobs,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Per-space quota store (SQLite). Stores ceilings in `space_quotas`;
 * counts are computed on-demand via COUNT(*) on the underlying tables,
 * scoped by space_id.
 *
 * The blobs table uses an empty-string sentinel for instance-wide rows;
 * count() for `blobs` filters by exact space_id, so platform-admin
 * uploads (under '') don't count against any specific space — the
 * empty-string sentinel acts as a separate "space" for quota purposes,
 * which is the correct behavior for hosted multi-space.
 */
export class SqliteSpaceQuotaStore implements SpaceQuotaStore {
  constructor(private db: DrizzleDb) {}

  async get(spaceId: string): Promise<SpaceQuota | null> {
    const row = await this.db
      .select()
      .from(spaceQuotas)
      .where(eq(spaceQuotas.space_id, spaceId))
      .get();
    if (!row) return null;
    return {
      space_id: row.space_id,
      items_limit: row.items_limit,
      webhooks_limit: row.webhooks_limit,
      blobs_limit: row.blobs_limit,
      storage_bytes_limit: row.storage_bytes_limit,
      rate_per_minute_limit: row.rate_per_minute_limit,
      updated_at: row.updated_at,
    };
  }

  async getForExistingSpace(
    spaceId: string,
  ): Promise<
    { exists: true; quota: SpaceQuota | null } | { exists: false; quota: null }
  > {
    return this.db.transaction(async (tx) => {
      // libsql write transactions use BEGIN IMMEDIATE, so this existence read
      // and the optional quota read cannot interleave with account deletion.
      const space = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .get();
      if (!space) return { exists: false, quota: null };

      const row = await tx
        .select()
        .from(spaceQuotas)
        .where(eq(spaceQuotas.space_id, spaceId))
        .get();
      return { exists: true, quota: row ? toSpaceQuota(row) : null };
    });
  }

  async set(
    spaceId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<SpaceQuota> {
    const now = new Date().toISOString();
    await this.db
      .insert(spaceQuotas)
      .values({
        space_id: spaceId,
        items_limit: input.items_limit ?? null,
        webhooks_limit: input.webhooks_limit ?? null,
        blobs_limit: input.blobs_limit ?? null,
        storage_bytes_limit: input.storage_bytes_limit ?? null,
        rate_per_minute_limit: input.rate_per_minute_limit ?? null,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: spaceQuotas.space_id,
        set: {
          items_limit: input.items_limit ?? null,
          webhooks_limit: input.webhooks_limit ?? null,
          blobs_limit: input.blobs_limit ?? null,
          storage_bytes_limit: input.storage_bytes_limit ?? null,
          rate_per_minute_limit: input.rate_per_minute_limit ?? null,
          updated_at: now,
        },
      })
      .run();
    return {
      space_id: spaceId,
      items_limit: input.items_limit ?? null,
      webhooks_limit: input.webhooks_limit ?? null,
      blobs_limit: input.blobs_limit ?? null,
      storage_bytes_limit: input.storage_bytes_limit ?? null,
      rate_per_minute_limit: input.rate_per_minute_limit ?? null,
      updated_at: now,
    };
  }

  async setForExistingSpace(
    spaceId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<SpaceQuota | null> {
    return this.db.transaction(async (tx) => {
      // libsql opens write transactions with BEGIN IMMEDIATE, so account
      // deletion and this existence-check-plus-upsert cannot interleave.
      const space = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .get();
      if (!space) return null;

      const now = new Date().toISOString();
      await tx
        .insert(spaceQuotas)
        .values({
          space_id: spaceId,
          items_limit: input.items_limit ?? null,
          webhooks_limit: input.webhooks_limit ?? null,
          blobs_limit: input.blobs_limit ?? null,
          storage_bytes_limit: input.storage_bytes_limit ?? null,
          rate_per_minute_limit: input.rate_per_minute_limit ?? null,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: spaceQuotas.space_id,
          set: {
            items_limit: input.items_limit ?? null,
            webhooks_limit: input.webhooks_limit ?? null,
            blobs_limit: input.blobs_limit ?? null,
            storage_bytes_limit: input.storage_bytes_limit ?? null,
            rate_per_minute_limit: input.rate_per_minute_limit ?? null,
            updated_at: now,
          },
        })
        .run();

      return {
        space_id: spaceId,
        items_limit: input.items_limit ?? null,
        webhooks_limit: input.webhooks_limit ?? null,
        blobs_limit: input.blobs_limit ?? null,
        storage_bytes_limit: input.storage_bytes_limit ?? null,
        rate_per_minute_limit: input.rate_per_minute_limit ?? null,
        updated_at: now,
      };
    });
  }

  async count(spaceId: string, resource: QuotaResource): Promise<number> {
    if (resource === "items") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(items)
        .where(eq(items.space_id, spaceId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "webhooks") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.space_id, spaceId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "blobs") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(blobs)
        .where(eq(blobs.space_id, spaceId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "storage_bytes") {
      // Counts every blob row for this space. The storage backend dedupes
      // physical files by hash, but each space owns their own row so the
      // same hash uploaded by two spaces counts against both.
      const row = await this.db
        .select({ s: sql<number>`coalesce(sum(${blobs.size}), 0)` })
        .from(blobs)
        .where(eq(blobs.space_id, spaceId))
        .get();
      return row?.s ?? 0;
    }
    // rate_per_minute is enforced by the rate-limit middleware, not via a
    // count query — no DB row to sum here.
    return 0;
  }
}

function toSpaceQuota(row: typeof spaceQuotas.$inferSelect): SpaceQuota {
  return {
    space_id: row.space_id,
    items_limit: row.items_limit,
    webhooks_limit: row.webhooks_limit,
    blobs_limit: row.blobs_limit,
    storage_bytes_limit: row.storage_bytes_limit,
    rate_per_minute_limit: row.rate_per_minute_limit,
    updated_at: row.updated_at,
  };
}
