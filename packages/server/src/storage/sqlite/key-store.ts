import { safeJsonParse } from "../json-utils.js";
import { and, eq, isNull } from "drizzle-orm";
import { generateId, MymeError, ErrorCode } from "@mymehq/shared";
import type {
  ApiKey,
  CreateKeyInput,
  EdgePermission,
  ExtensionPermission,
  Origin,
  TypePermission,
} from "@mymehq/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

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
    extension_permissions: safeJsonParse<Record<string, ExtensionPermission>>(
      row.extension_permissions,
      {},
      "key extension_permissions",
    ),
    edge_permissions: safeJsonParse<Record<string, EdgePermission>>(
      row.edge_permissions,
      {},
      "key edge_permissions",
    ),
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
  };
}

export class SqliteKeyStore implements KeyStore {
  constructor(private db: DrizzleDb) {}

  create(
    input: CreateKeyInput,
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey> {
    const collision = this.db
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
      )
      .get();
    if (collision) {
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
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      created_at: now,
    };
    this.db.insert(apiKeys).values(row).run();
    return Promise.resolve({
      id: row.id,
      tenant_id: tenantId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_origin: row.default_origin,
      default_library: row.default_library,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      created_at: now,
      last_used_at: null,
    });
  }

  list(): Promise<ApiKey[]> {
    const rows = this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at))
      .all();
    return Promise.resolve(rows.map(mapRow));
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
      ...mapRow(row),
      key_hash: row.key_hash,
      revoked_at: row.revoked_at,
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
