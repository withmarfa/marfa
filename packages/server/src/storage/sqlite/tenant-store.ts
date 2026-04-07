/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { Tenant } from "@myme/shared";
import type { TenantStore } from "../interface.js";
import { tenants } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

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
    return row;
  }

  async get(id: string): Promise<Tenant | null> {
    const row = this.db.select().from(tenants).where(eq(tenants.id, id)).get();
    return row ?? null;
  }
}
