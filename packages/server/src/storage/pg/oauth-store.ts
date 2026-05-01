import { safeJsonParse } from "../json-utils.js";
import { eq, and, isNull, gt } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type {
  OAuthClient,
  OAuthGrant,
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
import type { PgDb } from "./connection.js";

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
export class PgOAuthStore implements OAuthStore {
  constructor(private db: PgDb) {}

  // -----------------------------------------------------------------------
  // Clients (unchanged surface)
  // -----------------------------------------------------------------------

  async createClient(input: {
    name: string;
    redirect_uris: string[];
  }): Promise<OAuthClient> {
    const now = new Date().toISOString();
    const id = generateId();
    await this.db.insert(oauthClients).values({
      id,
      name: input.name,
      redirect_uris: JSON.stringify(input.redirect_uris),
      created_at: now,
    });
    return {
      id,
      name: input.name,
      redirect_uris: input.redirect_uris,
      created_at: now,
    };
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    const rows = await this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id));
    const row = rows[0];
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
    const rows = await this.db.select().from(oauthClients);
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
  // -----------------------------------------------------------------------

  async createGrant(clientId: string, scopes: string[]): Promise<OAuthGrant> {
    const now = new Date().toISOString();
    const id = generateId();
    const properties = {
      kind: "user-app-grant",
      client_id: clientId,
      scopes,
      status: "active",
      granted_at: now,
    };
    await this.db.insert(items).values({
      id,
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: JSON.stringify(properties),
      created_at: now,
      updated_at: now,
      timestamp: now,
      version: 1,
    });
    return { id, client_id: clientId, scopes, created_at: now };
  }

  async getGrantsByClient(clientId: string): Promise<OAuthGrant[]> {
    const rows = await this.db
      .select()
      .from(items)
      .where(
        and(eq(items.type, "system.connection"), eq(items.state, "active")),
      );
    const out: OAuthGrant[] = [];
    for (const row of rows) {
      const props = safeJsonParse<Record<string, unknown>>(
        row.properties,
        {},
        "system.connection properties",
      );
      if (
        props.kind === "user-app-grant" &&
        props.client_id === clientId &&
        props.status === "active"
      ) {
        out.push({
          id: row.id,
          client_id: clientId,
          scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
          created_at: row.created_at,
        });
      }
    }
    return out;
  }

  /** Read scopes off a system.connection item by id. */
  private async getConnectionScopes(
    connectionItemId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(items)
      .where(eq(items.id, connectionItemId));
    const row = rows[0];
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
    await this.db.insert(oauthCodes).values({
      id,
      connection_item_id: connectionItemId,
      code_hash: codeHash,
      code_challenge: challenge,
      code_challenge_method: method,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
      created_at: now,
    });
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
    const [row] = await this.db
      .update(oauthCodes)
      .set({ used_at: now })
      .where(
        and(
          eq(oauthCodes.code_hash, codeHash),
          isNull(oauthCodes.used_at),
          gt(oauthCodes.expires_at, now),
        ),
      )
      .returning();
    if (!row) return null;

    const scopes = await this.getConnectionScopes(row.connection_item_id);
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
    const scopes = await this.getConnectionScopes(connectionItemId);

    await this.db.insert(oauthTokens).values({
      id,
      connection_item_id: connectionItemId,
      token_hash: tokenHash,
      token_type: type,
      expires_at: expiresAt,
      created_at: now,
    });

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
  ): Promise<(OAuthToken & { scopes: string[] }) | null> {
    const rows = await this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.token_hash, tokenHash));
    const row = rows[0];
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    const scopes = await this.getConnectionScopes(row.connection_item_id);
    return {
      id: row.id,
      connection_item_id: row.connection_item_id,
      token_type: row.token_type as OAuthTokenType,
      scopes,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    };
  }

  async listTokens(): Promise<OAuthToken[]> {
    const rows = await this.db
      .select()
      .from(oauthTokens)
      .where(isNull(oauthTokens.revoked_at));
    const result: OAuthToken[] = [];
    for (const row of rows) {
      const scopes = await this.getConnectionScopes(row.connection_item_id);
      result.push({
        id: row.id,
        connection_item_id: row.connection_item_id,
        token_type: row.token_type as OAuthTokenType,
        scopes,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        created_at: row.created_at,
      });
    }
    return result;
  }

  async revokeToken(id: string): Promise<void> {
    await this.db
      .update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.id, id));
  }

  async reduceTokenScope(id: string, scopes: string[]): Promise<void> {
    const tokenRows = await this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.id, id));
    const token = tokenRows[0];
    if (!token) return;

    const itemRows = await this.db
      .select()
      .from(items)
      .where(eq(items.id, token.connection_item_id));
    const connection = itemRows[0];
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

    await this.db
      .update(items)
      .set({
        properties: JSON.stringify(updated),
        updated_at: new Date().toISOString(),
      })
      .where(eq(items.id, token.connection_item_id));
  }

  // -----------------------------------------------------------------------
  // Refresh rotation
  // -----------------------------------------------------------------------

  async markRefreshUsed(id: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.id, id));
    const row = rows[0];
    if (!row) return false;
    if (row.used_at) return false;

    await this.db
      .update(oauthTokens)
      .set({ used_at: new Date().toISOString() })
      .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.used_at)));
    return true;
  }

  async revokeGrantTokens(connectionItemId: string): Promise<void> {
    await this.db
      .update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.connection_item_id, connectionItemId));
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
