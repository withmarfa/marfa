import { safeJsonParse } from "../json-utils.js";
import { spaceBucketCondition, spaceCondition } from "../space-condition.js";
import {
  and,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  sum,
} from "drizzle-orm";
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
import { storedRole } from "../stored-role.js";
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
    space_id: row.space_id ?? undefined,
    label: row.label,
    source: row.source,
    role: storedRole(row.role, { table: "api_keys", id: row.id }),
    default_tier: row.default_tier as Tier,
    is_platform: row.is_platform,
    is_runtime_credential: row.is_runtime_credential,
    scope_enforced: row.scope_enforced,
    connection_id: row.connection_id ?? undefined,
    item_source: row.item_source ?? undefined,
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

/** Rows that are neither revoked nor past their expiry. `expires_at` is
 *  NULL for human-minted keys, so the NULL branch keeps them live. Without
 *  the expiry arm, an expired-but-not-yet-reaped runtime credential reads
 *  as active for up to a full reaper interval. */
function notRevokedOrExpired(nowIso: string) {
  return and(
    isNull(apiKeys.revoked_at),
    or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, nowIso)),
  );
}

export class PgKeyStore implements KeyStore {
  constructor(private db: PgDb) {}

  async create(
    input: CreateKeyInput & { scope_enforced?: boolean },
    keyHash: string,
    spaceId?: string,
  ): Promise<ApiKey> {
    const collision = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          spaceBucketCondition(apiKeys.space_id, spaceId),
          eq(apiKeys.source, input.source),
          isNull(apiKeys.revoked_at),
        ),
      );
    if (collision.length > 0) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Source display name "${input.source}" is already in use for this space`,
        { source: input.source },
      );
    }

    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      space_id: spaceId,
      key_hash: keyHash,
      label: input.label,
      source: input.source,
      role: input.role,
      default_tier: input.default_tier ?? "library",
      is_platform: input.is_platform ?? false,
      scope_enforced: input.scope_enforced ?? false,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
      created_at: now,
    };
    await this.db.insert(apiKeys).values(row);
    return {
      id: row.id,
      space_id: spaceId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_tier: row.default_tier,
      is_platform: row.is_platform,
      scope_enforced: row.scope_enforced,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
      created_at: now,
      last_used_at: null,
    };
  }

  async createRuntimeCredential(
    input: CreateKeyInput & {
      connection_id: string;
      expires_at: string;
      item_source: string | null;
    },
    keyHash: string,
    spaceId?: string,
  ): Promise<ApiKey> {
    const [collision] = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          spaceBucketCondition(apiKeys.space_id, spaceId),
          eq(apiKeys.source, input.source),
          isNull(apiKeys.revoked_at),
        ),
      );
    if (collision) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Source display name "${input.source}" is already in use for this space`,
        { source: input.source },
      );
    }

    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      space_id: spaceId,
      key_hash: keyHash,
      label: input.label,
      source: input.source,
      role: input.role,
      default_tier: input.default_tier ?? "library",
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      item_source: input.item_source ?? undefined,
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
      space_id: spaceId,
      label: row.label,
      source: row.source,
      role: input.role,
      default_tier: row.default_tier,
      is_platform: false,
      is_runtime_credential: true,
      connection_id: input.connection_id,
      item_source: input.item_source ?? undefined,
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
      .where(notRevokedOrExpired(new Date().toISOString()));
    return rows.map(mapRow);
  }

  async listForSpace(spaceId: string): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          spaceCondition(apiKeys.space_id, spaceId),
          isNull(apiKeys.revoked_at),
        ),
      );
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
    spaceId?: string,
  ): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.connection_id, connectionId),
          spaceCondition(apiKeys.space_id, spaceId),
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

  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .returning({ id: apiKeys.id });
    return result.length > 0;
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
    const [row] = await this.db
      .select({ total: count() })
      .from(apiKeys)
      .where(notRevokedOrExpired(new Date().toISOString()));
    return row?.total ?? 0;
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
    nowIso: string,
  ): Promise<number> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revoked_at: nowIso })
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

  async deleteRevokedKeysOlderThan(cutoffIso: string): Promise<number> {
    // `eq(..., false)` rather than `not(...)`: the column is NOT NULL with
    // a false default, so there is no third state to fall through.
    const rows = await this.db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.is_runtime_credential, false),
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
    // Aggregate in SQL. The table is bounded by the reaper's seven-day
    // window but that is still every dispatch in a week, far too many rows
    // to drag into JS for a counter on an operator dashboard.
    const [row] = await this.db
      .select({
        total: count(),
        active: sum(
          sql`CASE WHEN ${apiKeys.revoked_at} IS NULL AND (${apiKeys.expires_at} IS NULL OR ${apiKeys.expires_at} > ${nowIso}) THEN 1 ELSE 0 END`,
        ),
      })
      .from(apiKeys)
      .where(eq(apiKeys.is_runtime_credential, true));
    // `count()` maps to a number in drizzle; `sum()` comes back as a
    // string on Postgres, so only the latter needs converting.
    return { total: row?.total ?? 0, active: Number(row?.active ?? 0) };
  }
}
