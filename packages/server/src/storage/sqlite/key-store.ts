import { eq, isNull } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { ApiKey, CreateKeyInput, TypePermission } from "@myme/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteKeyStore implements KeyStore {
  constructor(private db: DrizzleDb) {}

  create(
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
    this.db.insert(apiKeys).values(row).run();
    return Promise.resolve({
      id: row.id,
      label: row.label,
      role: input.role,
      type_permissions: input.type_permissions ?? {},
      created_at: now,
    });
  }

  list(): Promise<ApiKey[]> {
    const rows = this.db.select().from(apiKeys).all();
    return Promise.resolve(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        role: row.role as "admin" | "member",
        type_permissions: JSON.parse(row.type_permissions) as Record<
          string,
          TypePermission
        >,
        created_at: row.created_at,
      })),
    );
  }

  validate(
    keyHash: string,
  ): Promise<
    (ApiKey & { key_hash: string; revoked_at: string | null }) | null
  > {
    const row = this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .get();
    if (!row) return Promise.resolve(null);
    if (row.revoked_at) return Promise.resolve(null);
    return Promise.resolve({
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
      tenant_id: row.tenant_id ?? undefined,
    });
  }

  revoke(id: string): Promise<void> {
    this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
    return Promise.resolve();
  }

  updateLastUsed(id: string): Promise<void> {
    this.db
      .update(apiKeys)
      .set({ last_used_at: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
    return Promise.resolve();
  }

  count(): Promise<number> {
    const rows = this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at))
      .all();
    return Promise.resolve(rows.length);
  }
}
