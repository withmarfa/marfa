import { eq } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Tenant, TenantConfig } from "@mymehq/shared";
import type { TenantStore } from "../interface.js";
import { tenants } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgTenantStore implements TenantStore {
  constructor(private db: PgDb) {}

  async create(name?: string): Promise<Tenant> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      name: name ?? null,
      created_at: now,
    };
    await this.db.insert(tenants).values(row);
    return { id: row.id, name: row.name, created_at: row.created_at };
  }

  async get(id: string): Promise<Tenant | null> {
    const [row] = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        created_at: tenants.created_at,
      })
      .from(tenants)
      .where(eq(tenants.id, id));
    return row ?? null;
  }

  async getConfig(id: string): Promise<TenantConfig | null> {
    const [row] = await this.db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!row || !row.config) return null;
    return row.config as TenantConfig;
  }

  async updateConfig(id: string, config: TenantConfig): Promise<void> {
    await this.db
      .update(tenants)
      .set({ config })
      .where(eq(tenants.id, id));
  }
}
