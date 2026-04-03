import { safeJsonParse } from "../json-utils.js";
import { eq, isNull } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { ApiKey, CreateKeyInput, TypePermission } from "@myme/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgKeyStore implements KeyStore {
  constructor(private db: PgDb) {}

  async create(
    input: CreateKeyInput,
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      tenant_id: tenantId,
      key_hash: keyHash,
      label: input.label,
      role: input.role,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      created_at: now,
    };
    await this.db.insert(apiKeys).values(row);
    return {
      id: row.id,
      label: row.label,
      role: input.role,
      type_permissions: input.type_permissions ?? {},
      created_at: now,
      last_used_at: null,
    };
  }

  async list(): Promise<ApiKey[]> {
    const rows = await this.db.select().from(apiKeys);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role as "admin" | "member",
      type_permissions: safeJsonParse<Record<string, TypePermission>>(
        row.type_permissions,
        {},
        "key type_permissions",
      ),
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? null,
    }));
  }

  async validate(
    keyHash: string,
  ): Promise<
    (ApiKey & { key_hash: string; revoked_at: string | null }) | null
  > {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash));
    if (!row) return null;
    if (row.revoked_at) return null;
    return {
      id: row.id,
      label: row.label,
      role: row.role as "admin" | "member",
      type_permissions: safeJsonParse<Record<string, TypePermission>>(
        row.type_permissions,
        {},
        "key type_permissions",
      ),
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? null,
      key_hash: row.key_hash,
      revoked_at: row.revoked_at,
      tenant_id: row.tenant_id ?? undefined,
    };
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id));
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ last_used_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id));
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at));
    return rows.length;
  }
}
