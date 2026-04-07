/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq, and } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { User } from "@myme/shared";
import type { UserStore } from "../interface.js";
import { users } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar_url: row.avatar_url,
    provider: row.provider,
    provider_id: row.provider_id,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteUserStore implements UserStore {
  constructor(private db: DrizzleDb) {}

  async create(input: {
    email: string;
    name?: string;
    avatar_url?: string;
    provider: string;
    provider_id: string;
    tenant_id: string;
  }): Promise<User> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      email: input.email,
      name: input.name ?? null,
      avatar_url: input.avatar_url ?? null,
      provider: input.provider,
      provider_id: input.provider_id,
      tenant_id: input.tenant_id,
      created_at: now,
      updated_at: now,
    };
    this.db.insert(users).values(row).run();
    return rowToUser(row);
  }

  async getById(id: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? rowToUser(row) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    return row ? rowToUser(row) : null;
  }

  async getByProvider(
    provider: string,
    providerId: string,
  ): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(
        and(eq(users.provider, provider), eq(users.provider_id, providerId)),
      )
      .get();
    return row ? rowToUser(row) : null;
  }

  async getByTenantId(tenantId: string): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.tenant_id, tenantId))
      .get();
    return row ? rowToUser(row) : null;
  }
}
