import { safeJsonParse } from "../json-utils.js";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { generateId, MymeError, ErrorCode } from "@mymehq/shared";
import type {
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  EdgePermission,
  ExtensionPermission,
  MetadataPermission,
  Origin,
  Tier,
  TypePermission,
} from "@mymehq/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Window within which repeated `last_used_at` writes for the same key
 * collapse to a single DB write. Mirrors the PG store so the two backends
 * stay behaviourally identical.
 */
const LAST_USED_DEBOUNCE_MS = 3_600_000;

function mapRow(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? undefined,
    label: row.label,
    source: row.source,
    role: row.role as "admin" | "member",
    default_origin: row.default_origin as Exclude<Origin, "system">,
    default_tier: row.default_tier as Tier,
    is_platform: row.is_platform,
    is_runtime_credential: row.is_runtime_credential,
    connection_id: row.connection_id ?? undefined,
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
    metadata_permissions: safeJsonParse<Record<string, MetadataPermission>>(
      row.metadata_permissions,
      {},
      "key metadata_permissions",
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
      default_tier: input.default_tier ?? "library",
      is_platform: input.is_platform ?? false,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
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
      default_tier: row.default_tier,
      is_platform: row.is_platform,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
      created_at: now,
      last_used_at: null,
    });
  }

  createRuntimeCredential(
    input: CreateKeyInput & { connection_id: string },
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
      default_tier: input.default_tier ?? "library",
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
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
      default_tier: row.default_tier,
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
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

  get(id: string): Promise<ApiKey | null> {
    const row = this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .get();
    return Promise.resolve(row ? mapRow(row) : null);
  }

  listByConnectionId(
    connectionId: string,
    tenantId?: string,
  ): Promise<ApiKey[]> {
    const rows = this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.connection_id, connectionId),
          tenantId === undefined
            ? isNull(apiKeys.tenant_id)
            : eq(apiKeys.tenant_id, tenantId),
          isNull(apiKeys.revoked_at),
        ),
      )
      .all();
    return Promise.resolve(rows.map(mapRow));
  }

  update(id: string, input: UpdateKeyInput): Promise<ApiKey> {
    const existing = this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .get();
    if (!existing) {
      throw new MymeError(ErrorCode.NOT_FOUND, `Key ${id} not found`);
    }

    const patch: Partial<typeof apiKeys.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.default_origin !== undefined)
      patch.default_origin = input.default_origin;
    if (input.default_tier !== undefined)
      patch.default_tier = input.default_tier;
    if (input.type_permissions !== undefined)
      patch.type_permissions = JSON.stringify(input.type_permissions);
    if (input.extension_permissions !== undefined)
      patch.extension_permissions = JSON.stringify(input.extension_permissions);
    if (input.edge_permissions !== undefined)
      patch.edge_permissions = JSON.stringify(input.edge_permissions);
    if (input.metadata_permissions !== undefined)
      patch.metadata_permissions = JSON.stringify(input.metadata_permissions);

    if (Object.keys(patch).length > 0) {
      this.db.update(apiKeys).set(patch).where(eq(apiKeys.id, id)).run();
    }

    const refreshed = this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .get();
    if (!refreshed) {
      // Shouldn't happen — existence was confirmed above. Defensive.
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        `Key ${id} disappeared mid-update`,
      );
    }
    return Promise.resolve(mapRow(refreshed));
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

  /**
   * DB-side debounce. See the pg key-store docstring — the conditional
   * WHERE makes this safe to call unconditionally from the auth
   * middleware across any number of instances without generating a write
   * storm.
   */
  updateLastUsed(id: string): Promise<void> {
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - LAST_USED_DEBOUNCE_MS,
    ).toISOString();
    this.db
      .update(apiKeys)
      .set({ last_used_at: now.toISOString() })
      .where(
        and(
          eq(apiKeys.id, id),
          or(isNull(apiKeys.last_used_at), lt(apiKeys.last_used_at, cutoff)),
        ),
      )
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
