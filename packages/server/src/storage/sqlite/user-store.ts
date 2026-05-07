import { eq, and } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { User } from "@mymehq/shared";
import type { UserStore, UpdateProfileInput } from "../interface.js";
import { users, auth_user } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    name: row.name,
    first_name: row.first_name,
    last_name: row.last_name,
    bio: row.bio,
    avatar_blob_hash: row.avatar_blob_hash,
    provider: row.provider,
    provider_id: row.provider_id,
    tenant_id: row.tenant_id,
    handle: row.handle,
    auth_user_id: row.auth_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteUserStore implements UserStore {
  constructor(private db: DrizzleDb) {}

  async create(input: {
    name?: string;
    provider: string;
    provider_id: string;
    tenant_id: string;
    handle?: string;
    auth_user_id?: string;
  }): Promise<User> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      name: input.name ?? null,
      first_name: null,
      last_name: null,
      bio: null,
      avatar_blob_hash: null,
      provider: input.provider,
      provider_id: input.provider_id,
      tenant_id: input.tenant_id,
      handle: input.handle ?? null,
      auth_user_id: input.auth_user_id ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db.insert(users).values(row).run();
    return rowToUser(row);
  }

  async setHandle(id: string, handle: string): Promise<User> {
    const now = new Date().toISOString();
    this.db
      .update(users)
      .set({ handle, updated_at: now })
      .where(eq(users.id, id))
      .run();
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new Error(`User ${id} not found`);
    return rowToUser(row);
  }

  async updateProfile(id: string, patch: UpdateProfileInput): Promise<User> {
    const now = new Date().toISOString();
    const set: Record<string, string | null> = { updated_at: now };
    if (patch.first_name !== undefined) set.first_name = patch.first_name;
    if (patch.last_name !== undefined) set.last_name = patch.last_name;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.avatar_blob_hash !== undefined) {
      set.avatar_blob_hash = patch.avatar_blob_hash;
    }
    this.db.update(users).set(set).where(eq(users.id, id)).run();
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new Error(`User ${id} not found`);
    return rowToUser(row);
  }

  async getByHandle(handle: string): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.handle, handle))
      .get();
    return row ? rowToUser(row) : null;
  }

  async getById(id: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? rowToUser(row) : null;
  }

  async getByAuthUserId(authUserId: string): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.auth_user_id, authUserId))
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

  async getAuthUserEmail(authUserId: string): Promise<{
    email: string;
    email_verified: boolean;
  } | null> {
    const row = this.db
      .select({
        email: auth_user.email,
        email_verified: auth_user.emailVerified,
      })
      .from(auth_user)
      .where(eq(auth_user.id, authUserId))
      .get();
    return row ?? null;
  }
}
