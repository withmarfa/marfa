import { safeJsonParse } from "../json-utils.js";
import { and, eq, isNull } from "drizzle-orm";
import {
  generateId,
  MymeError,
  ErrorCode,
} from "@mymehq/shared";
import type {
  ApiKey,
  CreateKeyInput,
  Origin,
  TypePermission,
} from "@mymehq/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { PgDb } from "./connection.js";

function mapRow(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? undefined,
    label: row.label,
    source: row.source,
    role: row.role as "admin" | "member",
    default_origin: row.default_origin as Origin,
    default_library: row.default_library,
    type_permissions: safeJsonParse<Record<string, TypePermission>>(
      row.type_permissions,
      {},
      "key type_permissions",
    ),
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
  };
}

export class PgKeyStore implements KeyStore {
  constructor(private db: PgDb) {}

  async create(
    input: CreateKeyInput,
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey> {
    const collision = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          tenantId === undefined
            ? isNull(apiKeys.tenant_id)
            : eq(apiKeys.tenant_id, tenantId),
          eq(apiKeys.source, input.source),
          isNull(apiKeys.revoked_at),
        ),
      );
    if (collision.length > 0) {
      throw new MymeError(
        ErrorCode.CONFLICT,
        `Source display name "${input.source}" is already in use for this tenant`,
        { source: input.source },
      );
    }

    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      tenant_id: tenantId,
      key_hash: keyHash,
      label: input.label,
      source: input.source,
      role: input.role,
      default_origin: input.default_origin ?? "user",
      default_library: input.default_library ?? false,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      created_at: now,
    };
    await this.db.insert(apiKeys).values(row);
    return {
      id: row.id,
      tenant_id: tenantId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_origin: row.default_origin as Origin,
      default_library: row.default_library,
      type_permissions: input.type_permissions ?? {},
      created_at: now,
      last_used_at: null,
    };
  }

  async list(): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at));
    return rows.map(mapRow);
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
      ...mapRow(row),
      key_hash: row.key_hash,
      revoked_at: row.revoked_at,
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
