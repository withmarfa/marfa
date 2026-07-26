import { eq, sql } from "drizzle-orm";
import type { TenantQuota, QuotaResource } from "@withmarfa/shared";
import type { TenantQuotaStore } from "../interface.js";
import {
  tenantQuotas,
  tenants,
  items,
  outboundWebhooks,
  blobs,
} from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Per-tenant quota store (Postgres). Counts via COUNT(*)::int.
 * See sqlite/tenant-quota-store.ts for design notes.
 */
export class PgTenantQuotaStore implements TenantQuotaStore {
  constructor(private db: PgDb) {}

  async get(tenantId: string): Promise<TenantQuota | null> {
    const [row] = await this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenant_id, tenantId));
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
      });
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

  async setForExistingTenant(
    tenantId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<TenantQuota | null> {
    return this.db.transaction(async (tx) => {
      // Account deletion takes the same row lock before removing quota data.
      // Whichever transaction wins becomes the linearization point: a delete
      // that wins makes this lookup return no row, while a quota update that
      // wins commits before the cascade removes both rows.
      const [tenant] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for("update");
      if (!tenant) return null;

      const now = new Date().toISOString();
      await tx
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
        });

      return {
        tenant_id: tenantId,
        items_limit: input.items_limit ?? null,
        webhooks_limit: input.webhooks_limit ?? null,
        blobs_limit: input.blobs_limit ?? null,
        storage_bytes_limit: input.storage_bytes_limit ?? null,
        rate_per_minute_limit: input.rate_per_minute_limit ?? null,
        updated_at: now,
      };
    });
  }

  async count(tenantId: string, resource: QuotaResource): Promise<number> {
    if (resource === "items") {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.tenant_id, tenantId));
      return row?.c ?? 0;
    }
    if (resource === "webhooks") {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.tenant_id, tenantId));
      return row?.c ?? 0;
    }
    if (resource === "blobs") {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(blobs)
        .where(eq(blobs.tenant_id, tenantId));
      return row?.c ?? 0;
    }
    if (resource === "storage_bytes") {
      // SUM(size) across the tenant's blob metadata rows. Aggregate
      // bytes can exceed INT_MAX, so the cast stays ::bigint;
      // node-postgres serializes bigint as a string — reflect in
      // sql<> and coerce on the way out. Mirrors pg/blob-store.ts.
      const [row] = await this.db
        .select({
          s: sql<string>`coalesce(sum(${blobs.size}), 0)::bigint`,
        })
        .from(blobs)
        .where(eq(blobs.tenant_id, tenantId));
      return Number(row?.s ?? 0);
    }
    return 0;
  }
}
