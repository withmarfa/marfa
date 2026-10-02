import { safeJsonParse } from "../json-utils.js";
import { and, count, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  generateId,
  MarfaError,
  ErrorCode,
  isPermission,
} from "@withmarfa/shared";
import type {
  CreateKeyInput,
  UpdateKeyInput,
  EdgePermission,
  EnforcementSettings,
  ExtensionPermission,
  MetadataPermission,
  ProfilePermission,
  Tier,
  TypePermission,
} from "@withmarfa/shared";
import type { KeyRevokeOutcome, KeyStore, StoredApiKey } from "../interface.js";
import { apiKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Window within which repeated `last_used_at` writes for the same key
 * collapse to a single DB write.
 */
const LAST_USED_DEBOUNCE_MS = 3_600_000;

function mapRow(row: typeof apiKeys.$inferSelect): StoredApiKey {
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    sources: safeJsonParse<string[]>(row.sources, [], "key sources"),
    default_tier: row.default_tier as Tier,
    is_operator: row.is_operator,
    // Narrowed to the literals this build knows, because the column is text
    // and a stored value outside the set is not a permission — it grants
    // nothing, and echoing it back would put a value off the route's own
    // declared enum into a 200 nobody validates. The filter also stops a
    // mint that names no permissions from copying such a value forward into
    // the row it writes.
    permissions: safeJsonParse<string[]>(
      row.permissions,
      [],
      "key permissions",
    ).filter(isPermission),
    oauth_client_id: row.oauth_client_id ?? undefined,
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
    profile_permissions: safeJsonParse<Record<string, ProfilePermission>>(
      row.profile_permissions,
      {},
      "key profile_permissions",
    ),
    ...(row.enforcement_override != null && {
      enforcement_override: safeJsonParse<EnforcementSettings>(
        row.enforcement_override,
        {},
        "key enforcement_override",
      ),
    }),
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    last_used_at: row.last_used_at ?? null,
  };
}

/** Rows that are neither revoked nor past their expiry. `expires_at` is
 *  NULL on every key a door mints, so the NULL branch keeps them live. The
 *  expiry arm is what stops a stamped row reading as active past its
 *  instant, since nothing revokes it on the way. */
function notRevokedOrExpired(nowIso: string) {
  return and(
    isNull(apiKeys.revoked_at),
    or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, nowIso)),
  );
}

export class SqliteKeyStore implements KeyStore {
  constructor(private db: DrizzleDb) {}

  async create(
    input: CreateKeyInput & { oauth_client_id?: string },
    keyHash: string,
  ): Promise<StoredApiKey> {
    const collision = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.source, input.source), isNull(apiKeys.revoked_at)))
      .get();
    if (collision) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Source "${input.source}" is already another key's own`,
        { source: input.source },
      );
    }

    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      key_hash: keyHash,
      label: input.label,
      source: input.source,
      sources: JSON.stringify(input.sources ?? []),
      default_tier: input.default_tier ?? "library",
      is_operator: input.is_operator ?? false,
      permissions: JSON.stringify(input.permissions ?? []),
      oauth_client_id: input.oauth_client_id ?? null,
      type_permissions: JSON.stringify(input.type_permissions ?? {}),
      extension_permissions: JSON.stringify(input.extension_permissions ?? {}),
      edge_permissions: JSON.stringify(input.edge_permissions ?? {}),
      metadata_permissions: JSON.stringify(input.metadata_permissions ?? {}),
      profile_permissions: JSON.stringify(input.profile_permissions ?? {}),
      enforcement_override:
        input.enforcement_override === undefined
          ? null
          : JSON.stringify(input.enforcement_override),
      created_at: now,
    };
    await this.db.insert(apiKeys).values(row).run();
    return {
      id: row.id,
      label: row.label,
      source: row.source,
      sources: input.sources ?? [],
      default_tier: row.default_tier,
      is_operator: row.is_operator,
      permissions: input.permissions ?? [],
      oauth_client_id: input.oauth_client_id,
      type_permissions: input.type_permissions ?? {},
      extension_permissions: input.extension_permissions ?? {},
      edge_permissions: input.edge_permissions ?? {},
      metadata_permissions: input.metadata_permissions ?? {},
      profile_permissions: input.profile_permissions ?? {},
      ...(input.enforcement_override !== undefined && {
        enforcement_override: input.enforcement_override,
      }),
      created_at: now,
      expires_at: null,
      last_used_at: null,
    };
  }

  async list(): Promise<StoredApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(notRevokedOrExpired(new Date().toISOString()))
      .all();
    return rows.map(mapRow);
  }

  async get(id: string): Promise<StoredApiKey | null> {
    const row = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .get();
    return row ? mapRow(row) : null;
  }

  async update(id: string, input: UpdateKeyInput): Promise<StoredApiKey> {
    const existing = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .get();
    if (!existing) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }

    const patch: Partial<typeof apiKeys.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.sources !== undefined)
      patch.sources = JSON.stringify(input.sources);
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
    // The two families of the permission model, patched like the rest:
    // dropping them here would answer 200 and change nothing on exactly the
    // two axes the model is about.
    if (input.permissions !== undefined)
      patch.permissions = JSON.stringify(input.permissions);
    if (input.profile_permissions !== undefined)
      patch.profile_permissions = JSON.stringify(input.profile_permissions);
    // `null` clears the override; an object replaces it whole.
    if (input.enforcement_override !== undefined)
      patch.enforcement_override =
        input.enforcement_override === null
          ? null
          : JSON.stringify(input.enforcement_override);

    if (Object.keys(patch).length > 0) {
      await this.db.update(apiKeys).set(patch).where(eq(apiKeys.id, id)).run();
    }

    const refreshed = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .get();
    if (!refreshed) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }
    return mapRow(refreshed);
  }

  async validate(
    keyHash: string,
  ): Promise<
    (StoredApiKey & { key_hash: string; revoked_at: string | null }) | null
  > {
    const row = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .get();
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

  async revoke(id: string): Promise<KeyRevokeOutcome> {
    const result = await this.db
      .update(apiKeys)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
      .run();
    if (result.rowsAffected > 0) return "revoked";
    // Read only on the miss, and only to say which miss it was.
    const row = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .get();
    return row ? "already_revoked" : "not_found";
  }

  /**
   * Debounced in the database rather than in the caller: the conditional
   * WHERE is what makes this safe to call unconditionally from the auth
   * middleware, from any number of processes, without a write storm.
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
      )
      .run();
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(apiKeys)
      .where(notRevokedOrExpired(new Date().toISOString()))
      .all();
    return row?.total ?? 0;
  }

  async deleteRevokedKeysOlderThan(cutoffIso: string): Promise<number> {
    const result = await this.db
      .delete(apiKeys)
      .where(
        and(isNotNull(apiKeys.revoked_at), lt(apiKeys.revoked_at, cutoffIso)),
      )
      .run();
    return result.rowsAffected;
  }
}
