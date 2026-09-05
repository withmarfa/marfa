import { eq, and, lt, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { OAuthDeviceCode, OAuthDeviceCodeStatus } from "@withmarfa/shared";
import type { OAuthStore } from "../interface.js";
import { WriteTracker } from "../write-tracker.js";
import { items, oauthDeviceCodes } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Device-flow state machine + OAuth grant `last_used_at` stamping.
 *
 * This store is scoped to device-flow state. The OAuth-protocol surfaces
 * (clients / codes / tokens) are owned by the @better-auth/oauth-provider
 * plugin tables (`auth_oauth_*`). See `auth/oauth-provider.ts` for the
 * rationale behind keeping device-flow here.
 */
export class PgOAuthStore implements OAuthStore {
  constructor(private db: PgDb) {}

  /**
   * In-flight tracking for the fire-and-forget `last_used_at` stamp. The
   * bearer middleware fires the stamp after the response and nothing
   * awaits it, so without tracking a stamp still opening its connection
   * when the pool closes surfaces as an unhandled rejection. Same shape
   * as the audit store's drain, which fixed the same class.
   */
  private readonly stamps = new WriteTracker("oauth-grant-stamp");

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

  async redeemDeviceCode(id: string): Promise<boolean> {
    const result = await this.db
      .update(oauthDeviceCodes)
      .set({ status: "redeemed" })
      .where(
        and(
          eq(oauthDeviceCodes.id, id),
          eq(oauthDeviceCodes.status, "approved"),
        ),
      )
      .returning({ id: oauthDeviceCodes.id });
    return result.length > 0;
  }

  async deleteDeviceCodesExpiredBefore(cutoffIso: string): Promise<number> {
    const result = await this.db
      .delete(oauthDeviceCodes)
      .where(lt(oauthDeviceCodes.expires_at, cutoffIso))
      .returning({ id: oauthDeviceCodes.id });
    return result.length;
  }

  async deleteDeviceCodesForGrant(connectionItemId: string): Promise<void> {
    await this.db
      .delete(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.connection_item_id, connectionItemId));
  }

  async deleteDeviceCodesForClient(clientId: string): Promise<number> {
    const result = await this.db
      .delete(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.client_id, clientId))
      .returning({ id: oauthDeviceCodes.id });
    return result.length;
  }

  /**
   * DB-side debounce for OAuth-grant `last_used_at`. Mirrors
   * `KeyStore.updateLastUsed` in shape — the conditional WHERE makes the
   * floor authoritative across instances. The middleware-side in-memory
   * cache (`oauthLastUsedCache` in `middleware/auth.ts`) stays as a
   * per-instance round-trip skip; this is the cluster-wide guarantee.
   *
   * Differs from the api-key path because `last_used_at` for an OAuth
   * grant is a JSON property inside `items.properties`, not a top-level
   * column. The merge uses `jsonb_set` to preserve every other property
   * verbatim. The text column is round-tripped through `::jsonb` for
   * the comparison and merge, then back to text for storage.
   */
  updateLastUsedAt(
    connectionItemId: string,
    spaceId: string | null,
    thresholdMs: number,
  ): Promise<void> {
    // Tracked so `close()` can drain an in-flight stamp; the returned
    // promise never rejects, matching the callers' fire-and-forget use.
    return this.stamps.track(() =>
      this.applyLastUsedAt(connectionItemId, spaceId, thresholdMs),
    );
  }

  /** Resolve once every in-flight stamp has settled. */
  drain(): Promise<void> {
    return this.stamps.drain();
  }

  private async applyLastUsedAt(
    connectionItemId: string,
    spaceId: string | null,
    thresholdMs: number,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
    const spacePredicate =
      spaceId === null
        ? sql`${items.space_id} IS NULL`
        : sql`${items.space_id} = ${spaceId}`;
    await this.db
      .update(items)
      .set({
        properties: sql`jsonb_set(${items.properties}, '{last_used_at}', to_jsonb(${nowIso}::text))`,
      })
      .where(
        and(
          eq(items.id, connectionItemId),
          spacePredicate,
          sql`(${items.properties}->>'last_used_at' IS NULL OR (${items.properties}->>'last_used_at') < ${cutoffIso})`,
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
