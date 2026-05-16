import { eq, and, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type {
  OAuthDeviceCode,
  OAuthDeviceCodeStatus,
} from "@mymehq/shared";
import type { OAuthStore } from "../interface.js";
import { items, oauthDeviceCodes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * Device-flow state machine + OAuth grant `last_used_at` stamping.
 *
 * T-131 narrowed this store: the OAuth-protocol surfaces (clients /
 * codes / tokens) moved to the @better-auth/oauth-provider plugin
 * tables (`auth_oauth_*`). The device-flow state machine stays here —
 * see `auth/oauth-provider.ts` §Caveats §1 for the rationale.
 */
export class SqliteOAuthStore implements OAuthStore {
  constructor(private db: DrizzleDb) {}

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

  /**
   * T-101: DB-side debounce for OAuth-grant `last_used_at`. See the
   * pg `updateLastUsedAt` docstring — the conditional WHERE makes
   * cluster-wide debounce authoritative; the middleware's in-memory
   * cache stays as the per-instance round-trip skip on top.
   *
   * SQLite uses `json_set` to merge `last_used_at` into the
   * `properties` text blob in place, and `json_extract` to read the
   * existing value for the conditional check. ISO-8601 timestamps
   * sort correctly as text, so the comparison is a plain `<`.
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
        properties: sql`json_set(${items.properties}, '$.last_used_at', ${nowIso})`,
      })
      .where(
        and(
          eq(items.id, connectionItemId),
          tenantPredicate,
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
