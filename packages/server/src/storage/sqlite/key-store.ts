import { eq, isNull } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { ApiKey, CreateKeyInput, TypePermission } from "@myme/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteKeyStore implements KeyStore {
  constructor(private db: DrizzleDb) {}

  async create(input: CreateKeyInput, keyHash: string): Promise<ApiKey> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      key_hash: keyHash,
      label: input.label,
      role: input.role,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      created_at: now,
    };
    this.db.insert(apiKeys).values(row).run();
    return {
      id: row.id,
      label: row.label,
      role: input.role,
      type_permissions: input.type_permissions ?? {},
      created_at: now,
    };
  }

  async list(): Promise<ApiKey[]> {
    const rows = this.db.select().from(apiKeys).all();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role as "admin" | "member",
      type_permissions: JSON.parse(row.type_permissions) as Record<
        string,
        TypePermission
      >,
      created_at: row.created_at,
    }));
  }

  async validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null> {
    const row = this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .get();
    if (!row) return null;
    if (row.revoked_at) return null;
    return {
      id: row.id,
      label: row.label,
      role: row.role as "admin" | "member",
      type_permissions: JSON.parse(row.type_permissions) as Record<
        string,
        TypePermission
      >,
      created_at: row.created_at,
      key_hash: row.key_hash,
      revoked_at: row.revoked_at,
    };
  }

  async revoke(id: string): Promise<void> {
    this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
  }

  async updateLastUsed(id: string): Promise<void> {
    this.db
      .update(apiKeys)
      .set({ last_used_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
  }

  async count(): Promise<number> {
    const rows = this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at))
      .all();
    return rows.length;
  }
}
