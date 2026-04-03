import { eq } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Tenant } from "@mymehq/shared";
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
    return row;
  }

  async get(id: string): Promise<Tenant | null> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    return row ?? null;
  }
}
