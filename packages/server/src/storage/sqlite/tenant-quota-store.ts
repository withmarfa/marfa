import { eq, sql } from "drizzle-orm";
import type { TenantQuota, QuotaResource } from "@withmarfa/shared";
import type { TenantQuotaStore } from "../interface.js";
import { tenantQuotas, items, outboundWebhooks, blobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Per-tenant quota store (SQLite). Stores ceilings in `tenant_quotas`;
 * counts are computed on-demand via COUNT(*) on the underlying tables,
 * scoped by tenant_id.
 *
 * The blobs table uses an empty-string sentinel for instance-wide rows;
 * count() for `blobs` filters by exact tenant_id, so platform-admin
 * uploads (under '') don't count against any specific tenant — the
 * empty-string sentinel acts as a separate "tenant" for quota purposes,
 * which is the correct behavior for hosted multi-tenant.
 */
export class SqliteTenantQuotaStore implements TenantQuotaStore {
  constructor(private db: DrizzleDb) {}

  async get(tenantId: string): Promise<TenantQuota | null> {
    const row = await this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenant_id, tenantId))
      .get();
    if (!row) return null;
    return {
      tenant_id: row.tenant_id,
      items_limit: row.items_limit,
      webhooks_limit: row.webhooks_limit,
      blobs_limit: row.blobs_limit,
      storage_bytes_limit: row.storage_bytes_limit,
      rate_per_minute_limit: row.rate_per_minute_limit,
      updated_at: row.updated_at,
    };
  }

  async set(
    tenantId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<TenantQuota> {
    const now = new Date().toISOString();
    await this.db
      .insert(tenantQuotas)
      .values({
        tenant_id: tenantId,
        items_limit: input.items_limit ?? null,
        webhooks_limit: input.webhooks_limit ?? null,
        blobs_limit: input.blobs_limit ?? null,
        storage_bytes_limit: input.storage_bytes_limit ?? null,
        rate_per_minute_limit: input.rate_per_minute_limit ?? null,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: tenantQuotas.tenant_id,
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
      tenant_id: tenantId,
      items_limit: input.items_limit ?? null,
      webhooks_limit: input.webhooks_limit ?? null,
      blobs_limit: input.blobs_limit ?? null,
      storage_bytes_limit: input.storage_bytes_limit ?? null,
      rate_per_minute_limit: input.rate_per_minute_limit ?? null,
      updated_at: now,
    };
  }

  async count(tenantId: string, resource: QuotaResource): Promise<number> {
    if (resource === "items") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(items)
        .where(eq(items.tenant_id, tenantId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "webhooks") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.tenant_id, tenantId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "blobs") {
      const row = await this.db
        .select({ c: sql<number>`count(*)` })
        .from(blobs)
        .where(eq(blobs.tenant_id, tenantId))
        .get();
      return row?.c ?? 0;
    }
    if (resource === "storage_bytes") {
      // Counts every blob row for this tenant. The storage backend dedupes
      // physical files by hash, but each tenant owns their own row so the
      // same hash uploaded by two tenants counts against both.
      const row = await this.db
        .select({ s: sql<number>`coalesce(sum(${blobs.size}), 0)` })
        .from(blobs)
        .where(eq(blobs.tenant_id, tenantId))
        .get();
      return row?.s ?? 0;
    }
    // rate_per_minute is enforced by the rate-limit middleware, not via a
    // count query — no DB row to sum here.
    return 0;
  }
}
