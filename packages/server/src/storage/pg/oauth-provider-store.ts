/**
 * T-131: thin read helpers over the @better-auth/oauth-provider plugin's
 * tables. See `interface.ts` (`OauthProviderStore`) for the contract.
 *
 * The plugin owns writes to `auth_oauth_client` and `auth_oauth_consent`;
 * we only read here for the consent-page render and the projection
 * after-hooks.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import { safeJsonParse } from "../json-utils.js";
import type {
  OauthAccessTokenRow,
  OauthClientRow,
  OauthProviderStore,
  MintTokenPairInput,
} from "../interface.js";
import {
  auth_oauth_access_token,
  auth_oauth_client,
  auth_oauth_consent,
  auth_oauth_refresh_token,
  items,
} from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgOauthProviderStore implements OauthProviderStore {
  constructor(private db: PgDb) {}

  async getClientName(clientId: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ name: auth_oauth_client.name })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    const row = rows[0];
    return row?.name ?? undefined;
  }

  async validateAccessToken(
    tokenHash: string,
  ): Promise<OauthAccessTokenRow | null> {
    const rows = await this.db
      .select({
        id: auth_oauth_access_token.id,
        userId: auth_oauth_access_token.userId,
        clientId: auth_oauth_access_token.clientId,
        referenceId: auth_oauth_access_token.referenceId,
        scopes: auth_oauth_access_token.scopes,
        expiresAt: auth_oauth_access_token.expiresAt,
        createdAt: auth_oauth_access_token.createdAt,
      })
      .from(auth_oauth_access_token)
      .where(eq(auth_oauth_access_token.token, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Expired tokens return null — fail closed.
    const expMs = row.expiresAt ? row.expiresAt.getTime() : null;
    if (expMs !== null && expMs < Date.now()) return null;
    const parsedScopes = safeJsonParse<unknown>(
      row.scopes,
      [],
      "auth_oauth_access_token.scopes",
    );
    const scopes = Array.isArray(parsedScopes)
      ? parsedScopes.filter((s): s is string => typeof s === "string")
      : [];
    return {
      id: row.id,
      userId: row.userId,
      clientId: row.clientId,
      referenceId: row.referenceId,
      scopes,
      expiresAtMs: expMs,
      createdAtMs: row.createdAt ? row.createdAt.getTime() : null,
    };
  }

  async getClient(clientId: string): Promise<OauthClientRow | null> {
    const rows = await this.db
      .select({
        id: auth_oauth_client.id,
        clientId: auth_oauth_client.clientId,
        name: auth_oauth_client.name,
        redirectUris: auth_oauth_client.redirectUris,
        referenceId: auth_oauth_client.referenceId,
      })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const parsed = safeJsonParse<unknown>(
      row.redirectUris,
      [],
      "auth_oauth_client.redirect_uris",
    );
    const redirectUris = Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
    return {
      id: row.id,
      clientId: row.clientId,
      name: row.name,
      redirectUris,
      referenceId: row.referenceId,
    };
  }

  async revokeTokensForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    await this.db
      .delete(auth_oauth_access_token)
      .where(
        and(
          eq(auth_oauth_access_token.clientId, clientId),
          eq(auth_oauth_access_token.userId, authUserId),
        ),
      );
    await this.db
      .delete(auth_oauth_refresh_token)
      .where(
        and(
          eq(auth_oauth_refresh_token.clientId, clientId),
          eq(auth_oauth_refresh_token.userId, authUserId),
        ),
      );
    await this.db
      .delete(auth_oauth_consent)
      .where(
        and(
          eq(auth_oauth_consent.clientId, clientId),
          eq(auth_oauth_consent.userId, authUserId),
        ),
      );
  }

  /**
   * T-131 follow-on (refresh-replay): delete ONLY access tokens for a
   * grant; leaves refresh tokens + consent intact. The plugin's own
   * deleteMany on stale-refresh deals with refresh-token cleanup —
   * this complements by nuking access tokens issued from the same
   * (now-poisoned) chain.
   */
  async revokeAccessTokensForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    await this.db
      .delete(auth_oauth_access_token)
      .where(
        and(
          eq(auth_oauth_access_token.clientId, clientId),
          eq(auth_oauth_access_token.userId, authUserId),
        ),
      );
  }

  /**
   * T-131 follow-on (refresh-replay): look up a refresh row by hashed
   * token. The plugin's `storeTokens.hash` matches the bearer middleware's
   * `hashApiKey(token, salt)` so callers compute the same hash to find
   * the row. Returns null if the token doesn't exist (e.g. cleaned up
   * by a prior pass).
   */
  async findRefreshTokenGrantKey(
    tokenHash: string,
  ): Promise<{ clientId: string; userId: string; revoked: boolean } | null> {
    const rows = await this.db
      .select({
        clientId: auth_oauth_refresh_token.clientId,
        userId: auth_oauth_refresh_token.userId,
        revoked: auth_oauth_refresh_token.revoked,
      })
      .from(auth_oauth_refresh_token)
      .where(eq(auth_oauth_refresh_token.token, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.clientId,
      userId: row.userId,
      revoked: Boolean(row.revoked),
    };
  }

  async mintTokenPair(input: MintTokenPairInput): Promise<void> {
    const refreshId = generateId();
    const now = new Date();
    const accessExpires = new Date(now.getTime() + input.accessTtlMs);
    const refreshExpires = new Date(now.getTime() + 30 * 86_400_000);
    const scopesJson = JSON.stringify(input.scopes);
    await this.db.insert(auth_oauth_refresh_token).values({
      id: refreshId,
      token: input.refreshTokenHash,
      clientId: input.clientId,
      userId: input.authUserId,
      referenceId: input.referenceId,
      expiresAt: refreshExpires,
      createdAt: now,
      scopes: scopesJson,
    });
    await this.db.insert(auth_oauth_access_token).values({
      id: generateId(),
      token: input.accessTokenHash,
      clientId: input.clientId,
      userId: input.authUserId,
      referenceId: input.referenceId,
      refreshId,
      expiresAt: accessExpires,
      createdAt: now,
      scopes: scopesJson,
    });
  }

  /**
   * T-131 follow-on: resolve the projected `system.connection { kind: "app" }`
   * item id for (tenantId, clientId, authUserId). Single-row lookup via
   * jsonb `->>` predicates on properties. Returns null if no projection
   * row exists.
   */
  async findGrantItemId(opts: {
    tenantId: string | null;
    clientId: string;
    authUserId: string;
  }): Promise<string | null> {
    const tenantPredicate =
      opts.tenantId === null
        ? sql`${items.tenant_id} IS NULL`
        : sql`${items.tenant_id} = ${opts.tenantId}`;
    const rows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.type, "system.connection"),
          tenantPredicate,
          sql`${items.properties}::jsonb->>'kind' = 'app'`,
          sql`${items.properties}::jsonb->>'client_id' = ${opts.clientId}`,
          sql`${items.properties}::jsonb->>'user_id' = ${opts.authUserId}`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * T-131 follow-on: merge a fresh `scopes` array (and refreshed `granted_at`)
   * into the projection's `properties`. Uses jsonb_set to preserve every
   * other property verbatim. Also bumps `updated_at` and increments
   * `version` so the row behaves like every other item under `/items?sort=
   * updated_at` and version-history listings. Tenant-scoped — pass `null`
   * for unscoped.
   */
  async updateGrantScopes(opts: {
    itemId: string;
    tenantId: string | null;
    scopes: string[];
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    const scopesJson = JSON.stringify(opts.scopes);
    const tenantPredicate =
      opts.tenantId === null
        ? sql`${items.tenant_id} IS NULL`
        : sql`${items.tenant_id} = ${opts.tenantId}`;
    await this.db
      .update(items)
      .set({
        properties: sql`(jsonb_set(jsonb_set(${items.properties}::jsonb, '{scopes}', ${scopesJson}::jsonb), '{granted_at}', to_jsonb(${nowIso}::text)))::text`,
        updated_at: nowIso,
        version: sql`${items.version} + 1`,
      })
      .where(and(eq(items.id, opts.itemId), tenantPredicate));
  }

  async getPriorConsent(
    clientId: string,
    authUserId: string,
  ): Promise<readonly string[] | undefined> {
    const rows = await this.db
      .select({ scopes: auth_oauth_consent.scopes })
      .from(auth_oauth_consent)
      .where(
        and(
          eq(auth_oauth_consent.clientId, clientId),
          eq(auth_oauth_consent.userId, authUserId),
        ),
      )
      .orderBy(desc(auth_oauth_consent.updatedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    // Better Auth's drizzle adapter stores `string[]` columns as JSON text.
    const parsed = safeJsonParse<unknown>(
      row.scopes,
      [],
      "auth_oauth_consent.scopes",
    );
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((s): s is string => typeof s === "string");
  }
}
