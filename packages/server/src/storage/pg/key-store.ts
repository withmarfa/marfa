import { safeJsonParse } from "../json-utils.js";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { generateId, MarfaError, ErrorCode } from "@withmarfa/shared";
import type {
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  EdgePermission,
  ExtensionPermission,
  MetadataPermission,
  Tier,
  TypePermission,
} from "@withmarfa/shared";
import type { KeyStore } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Window within which repeated `last_used_at` writes for the same key
 * collapse to a single DB write. Matches the in-memory debounce window in
 * `middleware/auth.ts`; the DB layer is authoritative across instances.
 */
const LAST_USED_DEBOUNCE_MS = 3_600_000;

function mapRow(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? undefined,
    label: row.label,
    source: row.source,
    role: row.role as "admin" | "tenant_admin" | "member",
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
    expires_at: row.expires_at ?? null,
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
      throw new MarfaError(
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
      default_tier: input.default_tier ?? "library",
      is_platform: input.is_platform ?? false,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
      created_at: now,
    };
    await this.db.insert(apiKeys).values(row);
    return {
      id: row.id,
      tenant_id: tenantId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_tier: row.default_tier,
      is_platform: row.is_platform,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
      created_at: now,
      last_used_at: null,
    };
  }

  async createRuntimeCredential(
    input: CreateKeyInput & { connection_id: string; expires_at: string },
    keyHash: string,
    tenantId?: string,
  ): Promise<ApiKey> {
    const [collision] = await this.db
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
    if (collision) {
      throw new MarfaError(
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
      default_tier: input.default_tier ?? "library",
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
      created_at: now,
      expires_at: input.expires_at,
    };
    await this.db.insert(apiKeys).values(row);
    return {
      id: row.id,
      tenant_id: tenantId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_tier: row.default_tier,
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
      created_at: now,
      expires_at: input.expires_at,
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

  async listForTenant(tenantId: string): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, tenantId), isNull(apiKeys.revoked_at)));
    return rows.map(mapRow);
  }

  async get(id: string): Promise<ApiKey | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)));
    return row ? mapRow(row) : null;
  }

  async listByConnectionId(
    connectionId: string,
    tenantId?: string,
  ): Promise<ApiKey[]> {
    const rows = await this.db
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
      );
    return rows.map(mapRow);
  }

  async update(id: string, input: UpdateKeyInput): Promise<ApiKey> {
    const [existing] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)));
    if (!existing) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Key ${id} not found`);
    }

    const patch: Partial<typeof apiKeys.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
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
      await this.db.update(apiKeys).set(patch).where(eq(apiKeys.id, id));
    }

    const [refreshed] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id));
    if (!refreshed) {
      // Shouldn't happen — existence was confirmed above. Defensive.
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        `Key ${id} disappeared mid-update`,
      );
    }
    return mapRow(refreshed);
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
    // A key past its hard lifetime bound is as dead as a revoked one —
    // same null so the middleware surfaces the same 401. ISO-8601 strings
    // compare correctly as strings.
    if (row.expires_at && row.expires_at <= new Date().toISOString()) {
      return null;
    }
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

  /**
   * Debounce `last_used_at` writes at the DB layer. Without this, every
   * instance in a multi-instance deployment would write once per its own
   * in-memory debounce window — so N instances producing N writes per
   * window per key. The conditional WHERE collapses that to at most one
   * write per `LAST_USED_DEBOUNCE_MS` per key, regardless of how many
   * instances are hitting the endpoint.
   *
   * Callers can still layer an in-memory debounce for a free round-trip
   * skip; the DB is now the authoritative floor.
   */
  async updateLastUsed(id: string): Promise<void> {
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - LAST_USED_DEBOUNCE_MS,
    ).toISOString();
    await this.db
      .update(apiKeys)
      .set({ last_used_at: now.toISOString() })
      .where(
        and(
          eq(apiKeys.id, id),
          or(isNull(apiKeys.last_used_at), lt(apiKeys.last_used_at, cutoff)),
        ),
      );
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revoked_at));
    return rows.length;
  }

  async revokeExpiredRuntimeCredentials(nowIso: string): Promise<number> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revoked_at: nowIso })
      .where(
        and(
          eq(apiKeys.is_runtime_credential, true),
          isNull(apiKeys.revoked_at),
          isNotNull(apiKeys.expires_at),
          lt(apiKeys.expires_at, nowIso),
        ),
      )
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  async revokeRuntimeCredentialsWithoutExpiryOlderThan(
    cutoffIso: string,
  ): Promise<number> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(
        and(
          eq(apiKeys.is_runtime_credential, true),
          isNull(apiKeys.revoked_at),
          isNull(apiKeys.expires_at),
          lt(apiKeys.created_at, cutoffIso),
        ),
      )
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  async deleteRevokedRuntimeCredentialsOlderThan(
    cutoffIso: string,
  ): Promise<number> {
    const rows = await this.db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.is_runtime_credential, true),
          isNotNull(apiKeys.revoked_at),
          lt(apiKeys.revoked_at, cutoffIso),
        ),
      )
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  async countRuntimeCredentials(
    nowIso: string,
  ): Promise<{ total: number; active: number }> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        revoked_at: apiKeys.revoked_at,
        expires_at: apiKeys.expires_at,
      })
      .from(apiKeys)
      .where(eq(apiKeys.is_runtime_credential, true));
    const active = rows.filter(
      (r) => !r.revoked_at && (!r.expires_at || r.expires_at > nowIso),
    ).length;
    return { total: rows.length, active };
  }
}
