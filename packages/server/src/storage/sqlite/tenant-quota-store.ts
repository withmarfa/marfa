import { eq, sql } from "drizzle-orm";
import type { TenantQuota, QuotaResource } from "@mymehq/shared";
import type { TenantQuotaStore } from "../interface.js";
import { tenantQuotas, items, outboundWebhooks, blobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * T-052 per-tenant quota store (SQLite). Stores ceilings in
 * `tenant_quotas`; counts are computed on-demand via COUNT(*) on the
 * underlying tables, scoped by tenant_id.
 *
 * The blobs table uses the empty-string sentinel for instance-wide rows
 * (T-049); count() for `blobs` filters by exact tenant_id, so platform-
 * admin uploads (under '') don't count against any specific tenant — the
 * empty-string sentinel acts as a separate "tenant" for quota purposes,
 * which is the right thing for hosted multi-tenant.
 */
export class SqliteTenantQuotaStore implements TenantQuotaStore {
  constructor(private db: DrizzleDb) {}

  get(tenantId: string): Promise<TenantQuota | null> {
    const row = this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenant_id, tenantId))
      .get();
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      tenant_id: row.tenant_id,
      items_limit: row.items_limit,
      webhooks_limit: row.webhooks_limit,
      blobs_limit: row.blobs_limit,
      storage_bytes_limit: row.storage_bytes_limit,
      rate_per_minute_limit: row.rate_per_minute_limit,
      updated_at: row.updated_at,
    });
  }

  set(
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
    this.db
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
    return Promise.resolve({
      tenant_id: tenantId,
      items_limit: input.items_limit ?? null,
      webhooks_limit: input.webhooks_limit ?? null,
      blobs_limit: input.blobs_limit ?? null,
      storage_bytes_limit: input.storage_bytes_limit ?? null,
      rate_per_minute_limit: input.rate_per_minute_limit ?? null,
      updated_at: now,
    });
  }

  count(tenantId: string, resource: QuotaResource): Promise<number> {
    if (resource === "items") {
      const row = this.db
        .select({ c: sql<number>`count(*)` })
        .from(items)
        .where(eq(items.tenant_id, tenantId))
        .get();
      return Promise.resolve(row?.c ?? 0);
    }
    if (resource === "webhooks") {
      const row = this.db
        .select({ c: sql<number>`count(*)` })
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.tenant_id, tenantId))
        .get();
      return Promise.resolve(row?.c ?? 0);
    }
    if (resource === "blobs") {
      const row = this.db
        .select({ c: sql<number>`count(*)` })
        .from(blobs)
        .where(eq(blobs.tenant_id, tenantId))
        .get();
      return Promise.resolve(row?.c ?? 0);
    }
    // storage_bytes / rate_per_minute deferred — no enforcement in this PR
    return Promise.resolve(0);
  }
}
