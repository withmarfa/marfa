import { eq } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Tenant, TenantConfig, TenantStatus } from "@mymehq/shared";
import type { TenantStore } from "../interface.js";
import { tenants } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { safeJsonParse } from "../json-utils.js";

export class SqliteTenantStore implements TenantStore {
  constructor(private db: DrizzleDb) {}

  async create(name?: string): Promise<Tenant> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      name: name ?? null,
      created_at: now,
    };
    await this.db.insert(tenants).values(row).run();
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      // T-117: column carries a NOT NULL DEFAULT 'active'; the insert above
      // omits it, so the DB stamps it. Echo back the same default on the
      // returned row so the caller doesn't need a follow-up read.
      status: "active",
    };
  }

  async get(id: string): Promise<Tenant | null> {
    const row = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as TenantStatus,
    };
  }

  async list(): Promise<Tenant[]> {
    const rows = await this.db.select().from(tenants).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as TenantStatus,
    }));
  }

  async getConfig(id: string): Promise<TenantConfig | null> {
    const row = await this.db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, id))
      .get();
    if (!row?.config) return null;
    return safeJsonParse<TenantConfig>(row.config, {}, `tenant ${id} config`);
  }

  async updateConfig(id: string, config: TenantConfig): Promise<void> {
    await this.db
      .update(tenants)
      .set({ config: JSON.stringify(config) })
      .where(eq(tenants.id, id))
      .run();
  }

  async suspend(id: string): Promise<Tenant | null> {
    return this.setStatus(id, "suspended");
  }

  async unsuspend(id: string): Promise<Tenant | null> {
    return this.setStatus(id, "active");
  }

  async getStatus(id: string): Promise<TenantStatus | null> {
    const row = await this.db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, id))
      .get();
    return (row?.status as TenantStatus | undefined) ?? null;
  }

  private async setStatus(
    id: string,
    status: TenantStatus,
  ): Promise<Tenant | null> {
    const rows = await this.db
      .update(tenants)
      .set({ status })
      .where(eq(tenants.id, id))
      .returning({
        id: tenants.id,
        name: tenants.name,
        created_at: tenants.created_at,
        status: tenants.status,
      });
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as TenantStatus,
    };
  }
}
