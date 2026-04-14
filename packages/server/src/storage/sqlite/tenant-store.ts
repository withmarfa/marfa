/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Tenant, TenantConfig } from "@mymehq/shared";
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
    this.db.insert(tenants).values(row).run();
    return { id: row.id, name: row.name, created_at: row.created_at };
  }

  async get(id: string): Promise<Tenant | null> {
    const row = this.db.select().from(tenants).where(eq(tenants.id, id)).get();
    if (!row) return null;
    return { id: row.id, name: row.name, created_at: row.created_at };
  }

  async getConfig(id: string): Promise<TenantConfig | null> {
    const row = this.db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, id))
      .get();
    if (!row || !row.config) return null;
    return safeJsonParse<TenantConfig>(row.config, {}, `tenant ${id} config`);
  }

  async updateConfig(id: string, config: TenantConfig): Promise<void> {
    this.db
      .update(tenants)
      .set({ config: JSON.stringify(config) })
      .where(eq(tenants.id, id))
      .run();
  }
}
