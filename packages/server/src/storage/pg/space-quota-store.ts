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
import type { PgDb } from "./connection.js";

/**
 * Per-space quota store (Postgres). Counts via COUNT(*)::int.
 * See sqlite/space-quota-store.ts for design notes.
 */
export class PgSpaceQuotaStore implements SpaceQuotaStore {
  constructor(private db: PgDb) {}

  async get(spaceId: string): Promise<SpaceQuota | null> {
    const [row] = await this.db
      .select()
      .from(spaceQuotas)
      .where(eq(spaceQuotas.space_id, spaceId));
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
      // Account deletion takes the same row lock. Whichever transaction wins
      // determines whether this read observes a live space or a 404.
      const [space] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for("update");
      if (!space) return { exists: false, quota: null };

      const [row] = await tx
        .select()
        .from(spaceQuotas)
        .where(eq(spaceQuotas.space_id, spaceId));
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
      });
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
      // Account deletion takes the same row lock before removing quota data.
      // Whichever transaction wins becomes the linearization point: a delete
      // that wins makes this lookup return no row, while a quota update that
      // wins commits before the cascade removes both rows.
      const [space] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for("update");
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
        });

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
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.space_id, spaceId));
      return row?.c ?? 0;
    }
    if (resource === "webhooks") {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.space_id, spaceId));
      return row?.c ?? 0;
    }
    if (resource === "blobs") {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(blobs)
        .where(eq(blobs.space_id, spaceId));
      return row?.c ?? 0;
    }
    if (resource === "storage_bytes") {
      // SUM(size) across the space's blob metadata rows. Aggregate
      // bytes can exceed INT_MAX, so the cast stays ::bigint;
      // node-postgres serializes bigint as a string — reflect in
      // sql<> and coerce on the way out. Mirrors pg/blob-store.ts.
      const [row] = await this.db
        .select({
          s: sql<string>`coalesce(sum(${blobs.size}), 0)::bigint`,
        })
        .from(blobs)
        .where(eq(blobs.space_id, spaceId));
      return Number(row?.s ?? 0);
    }
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
