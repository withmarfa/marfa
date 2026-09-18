import { lt, eq, and, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { OAuthDeviceCode, OAuthDeviceCodeStatus } from "@withmarfa/shared";
import type { OAuthStore } from "../interface.js";
import { WriteTracker } from "../write-tracker.js";
import { items, oauthDeviceCodes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Device-flow state machine + OAuth grant `last_used_at` stamping.
 *
 * The OAuth-protocol surfaces (clients / codes / tokens) are owned by
 * the @better-auth/oauth-provider plugin tables (`auth_oauth_*`). The
 * device-flow state machine stays here — see `auth/oauth-provider.ts`
 * §Caveats §1 for the rationale.
 */
export class SqliteOAuthStore implements OAuthStore {
  constructor(private db: DrizzleDb) {}

  /**
   * In-flight tracking for the fire-and-forget `last_used_at` stamp. The
   * bearer middleware fires the stamp after the response and nothing
   * awaits it, so without tracking a stamp still in flight when the
   * connection closes surfaces as an unhandled rejection. Same shape as
   * the audit store's drain, which fixed the same class.
   */
  private readonly stamps = new WriteTracker("oauth-grant-stamp");

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
    await this.db
      .insert(oauthDeviceCodes)
      .values({
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
      })
      .run();
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
    const row = await this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.device_code_hash, hash))
      .get();
    return row ? rowToDeviceCode(row) : null;
  }

  async findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<OAuthDeviceCode | null> {
    const row = await this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.user_code, userCode))
      .get();
    return row ? rowToDeviceCode(row) : null;
  }

  async markDeviceCodePolled(id: string, now: string): Promise<void> {
    await this.db
      .update(oauthDeviceCodes)
      .set({ last_polled_at: now })
      .where(eq(oauthDeviceCodes.id, id))
      .run();
  }

  async approveDeviceCode(
    id: string,
    connectionItemId: string,
    approvedScopes: readonly string[],
  ): Promise<boolean> {
    const result = await this.db
      .update(oauthDeviceCodes)
      .set({
        status: "approved",
        connection_item_id: connectionItemId,
        approved_at: new Date().toISOString(),
        // What may be issued, which after approval is what this row is for.
        // The requested set it replaces is still the audit row's `scopes`.
        scope: approvedScopes.join(" "),
      })
      .where(
        and(
          eq(oauthDeviceCodes.id, id),
          eq(oauthDeviceCodes.status, "pending"),
        ),
      )
      .run();
    return result.rowsAffected > 0;
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
      .run();
    return result.rowsAffected > 0;
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
      .run();
    return result.rowsAffected > 0;
  }

  async deleteDeviceCodesExpiredBefore(cutoffIso: string): Promise<number> {
    const result = await this.db
      .delete(oauthDeviceCodes)
      .where(lt(oauthDeviceCodes.expires_at, cutoffIso))
      .run();
    return result.rowsAffected;
  }

  async deleteDeviceCodesForGrant(connectionItemId: string): Promise<void> {
    await this.db
      .delete(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.connection_item_id, connectionItemId))
      .run();
  }

  async deleteDeviceCodesForClient(clientId: string): Promise<number> {
    const result = await this.db
      .delete(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.client_id, clientId))
      .run();
    return result.rowsAffected;
  }

  /**
   * DB-side debounce for OAuth-grant `last_used_at`. See the pg
   * `updateLastUsedAt` docstring — the conditional WHERE makes
   * cluster-wide debounce authoritative; the middleware's in-memory
   * cache stays as the per-instance round-trip skip on top.
   *
   * SQLite uses `json_set` to merge `last_used_at` into the `properties`
   * text blob in place, and `json_extract` to read the existing value for
   * the conditional check. ISO-8601 timestamps sort correctly as text,
   * so the comparison is a plain `<`.
   */
  updateLastUsedAt(
    connectionItemId: string,
    thresholdMs: number,
  ): Promise<void> {
    // Tracked so `close()` can drain an in-flight stamp; the returned
    // promise never rejects, matching the callers' fire-and-forget use.
    return this.stamps.track(() =>
      this.applyLastUsedAt(connectionItemId, thresholdMs),
    );
  }

  /** Resolve once every in-flight stamp has settled. */
  drain(): Promise<void> {
    return this.stamps.drain();
  }

  private async applyLastUsedAt(
    connectionItemId: string,
    thresholdMs: number,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - thresholdMs).toISOString();
    await this.db
      .update(items)
      .set({
        // jsonb_set, not json_set: json_set returns text and would silently
        // revert the stored JSONB blob to the old text encoding.
        properties: sql`jsonb_set(${items.properties}, '$.last_used_at', ${nowIso})`,
      })
      .where(
        and(
          eq(items.id, connectionItemId),
          sql`(json_extract(${items.properties}, '$.last_used_at') IS NULL OR json_extract(${items.properties}, '$.last_used_at') < ${cutoffIso})`,
        ),
      )
      .run();
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
