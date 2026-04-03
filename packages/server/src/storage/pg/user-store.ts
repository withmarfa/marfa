import { eq, and } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { User } from "@mymehq/shared";
import type { UserStore } from "../interface.js";
import { users } from "./schema.js";
import type { PgDb } from "./connection.js";

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

export class PgUserStore implements UserStore {
  constructor(private db: PgDb) {}

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
    await this.db.insert(users).values(row);
    return rowToUser(row);
  }

  async getById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? rowToUser(row) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return row ? rowToUser(row) : null;
  }

  async getByProvider(
    provider: string,
    providerId: string,
  ): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(
        and(eq(users.provider, provider), eq(users.provider_id, providerId)),
      );
    return row ? rowToUser(row) : null;
  }

  async getByTenantId(tenantId: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.tenant_id, tenantId));
    return row ? rowToUser(row) : null;
  }
}
