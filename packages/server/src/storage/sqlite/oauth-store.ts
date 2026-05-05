import { safeJsonParse } from "../json-utils.js";
import { eq, and, isNull, gt } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type {
  OAuthClient,
  OAuthToken,
  OAuthCode,
  OAuthTokenType,
  OAuthDeviceCode,
  OAuthDeviceCodeStatus,
} from "@mymehq/shared";
import type { OAuthStore } from "../interface.js";
import {
  items,
  oauthClients,
  oauthTokens,
  oauthCodes,
  oauthDeviceCodes,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * OAuth storage backed by a `system.connection` item per user-app-grant.
 *
 * PR 4 of workstream 1 dropped the standalone `oauth_grants` table; the
 * durable record of "user X approved client Y with scopes Z" now lives
 * as a typed item, queryable through the same DSL as the rest of myme.
 *
 * `oauth_codes` and `oauth_tokens` reference the item id via
 * `connection_item_id` (FK to `items.id`, ON DELETE CASCADE).
 */
export class SqliteOAuthStore implements OAuthStore {
  constructor(private db: DrizzleDb) {}

  // -----------------------------------------------------------------------
  // Clients (unchanged surface)
  // -----------------------------------------------------------------------

  async createClient(input: {
    name: string;
    redirect_uris: string[];
  }): Promise<OAuthClient> {
    const now = new Date().toISOString();
    const id = generateId();
    this.db
      .insert(oauthClients)
      .values({
        id,
        name: input.name,
        redirect_uris: JSON.stringify(input.redirect_uris),
        created_at: now,
      })
      .run();
    return {
      id,
      name: input.name,
      redirect_uris: input.redirect_uris,
      created_at: now,
    };
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    const row = this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id))
      .get();
    if (!row) return null;
    return {
      ...row,
      redirect_uris: safeJsonParse<string[]>(
        row.redirect_uris,
        [],
        "oauth redirect_uris",
      ),
    };
  }

  async listClients(): Promise<OAuthClient[]> {
    const rows = this.db.select().from(oauthClients).all();
    return rows.map((r) => ({
      ...r,
      redirect_uris: safeJsonParse<string[]>(
        r.redirect_uris,
        [],
        "oauth redirect_uris",
      ),
    }));
  }

  // -----------------------------------------------------------------------
  // Grants (system.connection items, kind: user-app-grant)
  //
  // Grant creation is performed at the route layer via `storage.items.create`
  // so the user-app-grant item gets full ItemStore treatment: `tenant_id`
  // stamping, search indexing, metadata-row insertion, type validation, and
  // event emission. Direct `db.insert(items)` here was the WS1-PR4 source of
  // the cross-tenant leak (T-005).
  // -----------------------------------------------------------------------

  /** Read scopes off a system.connection item by id. */
  private getConnectionScopes(connectionItemId: string): string[] {
    const row = this.db
      .select()
      .from(items)
      .where(eq(items.id, connectionItemId))
      .get();
    if (!row) return [];
    const props = safeJsonParse<Record<string, unknown>>(
      row.properties,
      {},
      "system.connection properties",
    );
    return Array.isArray(props.scopes) ? (props.scopes as string[]) : [];
  }

  // -----------------------------------------------------------------------
  // Codes
  // -----------------------------------------------------------------------

  async createCode(
    connectionItemId: string,
    codeHash: string,
    challenge: string,
    method: string,
    redirectUri: string,
    expiresAt: string,
  ): Promise<OAuthCode> {
    const now = new Date().toISOString();
    const id = generateId();
    this.db
      .insert(oauthCodes)
      .values({
        id,
        connection_item_id: connectionItemId,
        code_hash: codeHash,
        code_challenge: challenge,
        code_challenge_method: method,
        redirect_uri: redirectUri,
        expires_at: expiresAt,
        created_at: now,
      })
      .run();
    return {
      id,
      connection_item_id: connectionItemId,
      code_challenge: challenge,
      code_challenge_method: method,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
      used_at: null,
      created_at: now,
    };
  }

  async consumeCode(
    codeHash: string,
  ): Promise<(OAuthCode & { scopes: string[] }) | null> {
    const now = new Date().toISOString();
    const row = this.db
      .update(oauthCodes)
      .set({ used_at: now })
      .where(
        and(
          eq(oauthCodes.code_hash, codeHash),
          isNull(oauthCodes.used_at),
          gt(oauthCodes.expires_at, now),
        ),
      )
      .returning()
      .get();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- row is undefined when UPDATE matches no rows
    if (!row) return null;

    const scopes = this.getConnectionScopes(row.connection_item_id);
    return {
      id: row.id,
      connection_item_id: row.connection_item_id,
      code_challenge: row.code_challenge,
      code_challenge_method: row.code_challenge_method,
      redirect_uri: row.redirect_uri,
      expires_at: row.expires_at,
      used_at: row.used_at,
      created_at: row.created_at,
      scopes,
    };
  }

  // -----------------------------------------------------------------------
  // Tokens
  // -----------------------------------------------------------------------

  async createToken(
    connectionItemId: string,
    tokenHash: string,
    type: OAuthTokenType,
    expiresAt: string,
  ): Promise<OAuthToken> {
    const now = new Date().toISOString();
    const id = generateId();
    const scopes = this.getConnectionScopes(connectionItemId);

    this.db
      .insert(oauthTokens)
      .values({
        id,
        connection_item_id: connectionItemId,
        token_hash: tokenHash,
        token_type: type,
        expires_at: expiresAt,
        created_at: now,
      })
      .run();

    return {
      id,
      connection_item_id: connectionItemId,
      token_type: type,
      scopes,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: now,
    };
  }

  async validateToken(
    tokenHash: string,
  ): Promise<
    (OAuthToken & { scopes: string[]; tenant_id: string | null }) | null
  > {
    // Join through to the user-app-grant `system.connection` to project the
    // grant's `tenant_id` onto the validation result. The middleware uses this
    // to stamp `tenant_id` on the synthetic ApiKey so storage call sites
    // tenant-filter correctly (T-004).
    const row = this.db
      .select({
        id: oauthTokens.id,
        connection_item_id: oauthTokens.connection_item_id,
        token_type: oauthTokens.token_type,
        expires_at: oauthTokens.expires_at,
        revoked_at: oauthTokens.revoked_at,
        created_at: oauthTokens.created_at,
        tenant_id: items.tenant_id,
      })
      .from(oauthTokens)
      .leftJoin(items, eq(items.id, oauthTokens.connection_item_id))
      .where(eq(oauthTokens.token_hash, tokenHash))
      .get();
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    const scopes = this.getConnectionScopes(row.connection_item_id);
    return {
      id: row.id,
      connection_item_id: row.connection_item_id,
      token_type: row.token_type as OAuthTokenType,
      scopes,
      tenant_id: row.tenant_id ?? null,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    };
  }

  async listTokens(): Promise<OAuthToken[]> {
    const rows = this.db
      .select()
      .from(oauthTokens)
      .where(isNull(oauthTokens.revoked_at))
      .all();
    return rows.map((row) => ({
      id: row.id,
      connection_item_id: row.connection_item_id,
      token_type: row.token_type as OAuthTokenType,
      scopes: this.getConnectionScopes(row.connection_item_id),
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    }));
  }

  async revokeToken(id: string): Promise<void> {
    this.db
      .update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.id, id))
      .run();
  }

  async reduceTokenScope(id: string, scopes: string[]): Promise<void> {
    // Reduce scope by intersecting the connection item's scopes.
    const token = this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.id, id))
      .get();
    if (!token) return;

    const connection = this.db
      .select()
      .from(items)
      .where(eq(items.id, token.connection_item_id))
      .get();
    if (!connection) return;

    const props = safeJsonParse<Record<string, unknown>>(
      connection.properties,
      {},
      "system.connection properties",
    );
    const currentScopes = Array.isArray(props.scopes)
      ? (props.scopes as string[])
      : [];
    const reduced = currentScopes.filter((s) => scopes.includes(s));
    const updated = { ...props, scopes: reduced };

    this.db
      .update(items)
      .set({
        properties: JSON.stringify(updated),
        updated_at: new Date().toISOString(),
      })
      .where(eq(items.id, token.connection_item_id))
      .run();
  }

  // -----------------------------------------------------------------------
  // Refresh rotation
  // -----------------------------------------------------------------------

  async markRefreshUsed(id: string): Promise<boolean> {
    const row = this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.id, id))
      .get();
    if (!row) return false;
    if (row.used_at) return false; // Already used — replay detected

    this.db
      .update(oauthTokens)
      .set({ used_at: new Date().toISOString() })
      .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.used_at)))
      .run();
    return true;
  }

  async revokeGrantTokens(connectionItemId: string): Promise<void> {
    this.db
      .update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.connection_item_id, connectionItemId))
      .run();
  }

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
    this.db
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
    const row = this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.device_code_hash, hash))
      .get();
    return row ? rowToDeviceCode(row) : null;
  }

  async findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<OAuthDeviceCode | null> {
    const row = this.db
      .select()
      .from(oauthDeviceCodes)
      .where(eq(oauthDeviceCodes.user_code, userCode))
      .get();
    return row ? rowToDeviceCode(row) : null;
  }

  async markDeviceCodePolled(id: string, now: string): Promise<void> {
    this.db
      .update(oauthDeviceCodes)
      .set({ last_polled_at: now })
      .where(eq(oauthDeviceCodes.id, id))
      .run();
  }

  async approveDeviceCode(
    id: string,
    connectionItemId: string,
  ): Promise<boolean> {
    const result = this.db
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
    return result.changes > 0;
  }

  async denyDeviceCode(id: string): Promise<boolean> {
    const result = this.db
      .update(oauthDeviceCodes)
      .set({ status: "denied" })
      .where(
        and(
          eq(oauthDeviceCodes.id, id),
          eq(oauthDeviceCodes.status, "pending"),
        ),
      )
      .run();
    return result.changes > 0;
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
