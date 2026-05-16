import { eq, and, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type {
  OAuthDeviceCode,
  OAuthDeviceCodeStatus,
} from "@mymehq/shared";
import type { OAuthStore } from "../interface.js";
import { items, oauthDeviceCodes } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Device-flow state machine + OAuth grant `last_used_at` stamping.
 *
 * T-131 narrowed this store: the OAuth-protocol surfaces (clients /
 * codes / tokens) moved to the @better-auth/oauth-provider plugin
 * tables (`auth_oauth_*`). The device-flow state machine stays here —
 * see `auth/oauth-provider.ts` §Caveats §1 for the rationale.
 */
export class PgOAuthStore implements OAuthStore {
  constructor(private db: PgDb) {}

  // -----------------------------------------------------------------------
  // Device Authorization Grant
  // -----------------------------------------------------------------------

  async createDeviceCode(input: {
    deviceCodeHash: string;
    userCode: string;
    clientId: string;
    scope: string;
    expiresAt: string;
    intervalSeconds: number;
  }): Promise<OAuthDeviceCode> {
    const id = generateId();
    const now = new Date().toISOString();
    await this.db.insert(oauthDeviceCodes).values({
      id,
      device_code_hash: input.deviceCodeHash,
      user_code: input.userCode,
      client_id: input.clientId,
      scope: input.scope,
      status: "pending",
      connection_item_id: null,
      expires_at: input.expiresAt,
      interval_seconds: input.intervalSeconds,
      last_polled_at: null,
      approved_at: null,
      created_at: now,
    });
    return {
      id,
      user_code: input.userCode,
      client_id: input.clientId,
      scopes: input.scope.split(" ").filter(Boolean),
      status: "pending",
      connection_item_id: null,
      expires_at: input.expiresAt,
      interval_seconds: input.intervalSeconds,
      last_polled_at: null,
      approved_at: null,
      created_at: now,
    };
  }

  async findDeviceCodeByHash(hash: string): Promise<OAuthDeviceCode | null> {
    const rows = await this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.device_code_hash, hash));
    const row = rows[0];
    return row ? rowToDeviceCode(row) : null;
  }

  async findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<OAuthDeviceCode | null> {
    const rows = await this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.user_code, userCode));
    const row = rows[0];
    return row ? rowToDeviceCode(row) : null;
  }

  async markDeviceCodePolled(id: string, now: string): Promise<void> {
    await this.db
      .update(oauthDeviceCodes)
      .set({ last_polled_at: now })
      .where(eq(oauthDeviceCodes.id, id));
  }

  async approveDeviceCode(
    id: string,
    connectionItemId: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(oauthDeviceCodes)
      .set({
        status: "approved",
        connection_item_id: connectionItemId,
        approved_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(oauthDeviceCodes.id, id),
          eq(oauthDeviceCodes.status, "pending"),
        ),
      )
      .returning({ id: oauthDeviceCodes.id });
    return result.length > 0;
  }

  async denyDeviceCode(id: string): Promise<boolean> {
    const result = await this.db
      .update(oauthDeviceCodes)
      .set({ status: "denied" })
      .where(
        and(
          eq(oauthDeviceCodes.id, id),
          eq(oauthDeviceCodes.status, "pending"),
        ),
      )
      .returning({ id: oauthDeviceCodes.id });
    return result.length > 0;
  }

  /**
   * T-101: DB-side debounce for OAuth-grant `last_used_at`. Mirrors
   * `KeyStore.updateLastUsed` in shape — the conditional WHERE makes
   * the floor authoritative across instances. The middleware-side
   * in-memory cache (`oauthLastUsedCache` in `middleware/auth.ts`)
   * stays as a per-instance round-trip skip; this is the cluster-wide
   * guarantee.
   *
   * Differs from the api-key path because `last_used_at` for an OAuth
   * grant is a JSON property inside `items.properties`, not a top-level
   * column. The merge uses `jsonb_set` to preserve every other property
   * verbatim. The text column is round-tripped through `::jsonb` for
   * the comparison and merge, then back to text for storage.
   */
  async updateLastUsedAt(
    connectionItemId: string,
    tenantId: string | null,
    thresholdMs: number,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
    const tenantPredicate =
      tenantId === null
        ? sql`${items.tenant_id} IS NULL`
        : sql`${items.tenant_id} = ${tenantId}`;
    await this.db
      .update(items)
      .set({
        properties: sql`(jsonb_set(${items.properties}::jsonb, '{last_used_at}', to_jsonb(${nowIso}::text)))::text`,
      })
      .where(
        and(
          eq(items.id, connectionItemId),
          tenantPredicate,
          sql`(${items.properties}::jsonb->>'last_used_at' IS NULL OR (${items.properties}::jsonb->>'last_used_at') < ${cutoffIso})`,
        ),
      );
  }
}

function rowToDeviceCode(row: {
  id: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: string;
  connection_item_id: string | null;
  expires_at: string;
  interval_seconds: number;
  last_polled_at: string | null;
  approved_at: string | null;
  created_at: string;
}): OAuthDeviceCode {
  return {
    id: row.id,
    user_code: row.user_code,
    client_id: row.client_id,
    scopes: row.scope.split(" ").filter(Boolean),
    status: row.status as OAuthDeviceCodeStatus,
    connection_item_id: row.connection_item_id,
    expires_at: row.expires_at,
    interval_seconds: row.interval_seconds,
    last_polled_at: row.last_polled_at,
    approved_at: row.approved_at,
    created_at: row.created_at,
  };
}
