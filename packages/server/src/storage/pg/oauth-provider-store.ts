/**
 * Thin read helpers over the @better-auth/oauth-provider plugin's tables.
 * See `interface.ts` (`OauthProviderStore`) for the contract.
 *
 * The plugin owns writes to `auth_oauth_client` and `auth_oauth_consent`;
 * reads here support the consent-page render and the projection after-hooks.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type {
  CreateClientInput,
  CreateClientResult,
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
import { isPublicClient } from "../oauth-client-trust.js";
import { sameScopeSet } from "../consent-scopes.js";

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
    const scopes = Array.isArray(row.scopes)
      ? row.scopes.filter((s): s is string => typeof s === "string")
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
        postLogoutRedirectUris: auth_oauth_client.postLogoutRedirectUris,
        referenceId: auth_oauth_client.referenceId,
        public: auth_oauth_client.public,
        tokenEndpointAuthMethod: auth_oauth_client.tokenEndpointAuthMethod,
        scopes: auth_oauth_client.scopes,
      })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // A NULL column means "no ceiling"; an array — including an empty one —
    // is a real ceiling. Never collapse the two (see `OauthClientRow.scopes`).
    const scopes = Array.isArray(row.scopes)
      ? row.scopes.filter((s): s is string => typeof s === "string")
      : null;
    const redirectUris = Array.isArray(row.redirectUris)
      ? row.redirectUris.filter((s): s is string => typeof s === "string")
      : [];
    const postLogoutRedirectUris = Array.isArray(row.postLogoutRedirectUris)
      ? row.postLogoutRedirectUris.filter(
          (s): s is string => typeof s === "string",
        )
      : [];
    return {
      id: row.id,
      clientId: row.clientId,
      name: row.name,
      redirectUris,
      postLogoutRedirectUris,
      referenceId: row.referenceId,
      isPublic: isPublicClient(row.public, row.tokenEndpointAuthMethod),
      scopes,
    };
  }

  async updateClientLogoutConfig(
    clientId: string,
    postLogoutRedirectUris: readonly string[],
  ): Promise<boolean> {
    const updated = await this.db
      .update(auth_oauth_client)
      .set({
        enableEndSession: true,
        postLogoutRedirectUris: [...postLogoutRedirectUris],
        updatedAt: new Date(),
      })
      .where(eq(auth_oauth_client.clientId, clientId))
      .returning({ id: auth_oauth_client.id });
    return updated.length > 0;
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
    await this.revokeAuthorizationCodesForGrant(clientId, authUserId);
  }

  async findAuthorizationCodeGrantKey(codeHash: string): Promise<{
    clientId: string;
    userId: string;
    hasConsent: boolean;
  } | null> {
    const rows = await this.db.execute<{
      client_id: string;
      user_id: string;
      consent_id: string | null;
    }>(sql`
      SELECT v.value::jsonb->'query'->>'client_id' AS client_id,
             v.value::jsonb->>'userId'             AS user_id,
             c.id                                   AS consent_id
      FROM auth_verification v
      LEFT JOIN auth_oauth_consent c
        ON c.client_id = v.value::jsonb->'query'->>'client_id'
       AND c.user_id   = v.value::jsonb->>'userId'
      WHERE v.identifier = ${codeHash}
        AND v.value::jsonb->>'type' = 'authorization_code'
      LIMIT 1
    `);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) return null;
    const clientId = row.client_id;
    const userId = row.user_id;
    if (typeof clientId !== "string" || typeof userId !== "string") return null;
    return { clientId, userId, hasConsent: row.consent_id != null };
  }

  async revokeAuthorizationCodesForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    // Authorization codes are not in the plugin's own tables. They live as
    // `auth_verification` rows whose `value` is a JSON blob carrying the
    // grant they belong to, so reaching them means querying inside it.
    await this.db.execute(sql`
      DELETE FROM auth_verification
      WHERE value::jsonb->>'type' = 'authorization_code'
        AND value::jsonb->'query'->>'client_id' = ${clientId}
        AND value::jsonb->>'userId' = ${authUserId}
    `);
  }

  /**
   * Delete ONLY access tokens for a grant; leaves refresh tokens + consent
   * intact. The plugin's own deleteMany on stale-refresh deals with
   * refresh-token cleanup — this complements by revoking access tokens
   * issued from the same (now-poisoned) chain.
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
   * Look up a refresh row by hashed token. The plugin's `storeTokens.hash`
   * matches the bearer middleware's `hashApiKey(token, salt)` so callers
   * compute the same hash to find the row. Returns null if the token doesn't
   * exist (e.g. cleaned up by a prior pass).
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
    const scopes = [...input.scopes];
    await this.db.insert(auth_oauth_refresh_token).values({
      id: refreshId,
      token: input.refreshTokenHash,
      clientId: input.clientId,
      userId: input.authUserId,
      referenceId: input.referenceId,
      expiresAt: refreshExpires,
      createdAt: now,
      scopes,
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
      scopes,
    });
  }

  async clientExists(clientId: string): Promise<boolean> {
    const rows = await this.db
      .select({ clientId: auth_oauth_client.clientId })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    return rows.length > 0;
  }

  async createClient(input: CreateClientInput): Promise<CreateClientResult> {
    // PK on auth_oauth_client.id (separate from the business key
    // `client_id`). The plugin's own DCR generates a random 32-char
    // string for both; we reuse `generateId()` for the PK and accept
    // the caller's clientId. Format-wise the PK only needs uniqueness.
    const id = generateId();
    const now = new Date();
    // `string[]` fields are now native PG `text[]` columns — pass arrays
    // directly. The Better Auth Drizzle adapter expects PG-native arrays
    // for `string[]`-typed fields (`supportsArrays: true` on the pg
    // provider); see `auth_oauth_client.scopes` in the schema for the
    // wider rationale.
    await this.db.insert(auth_oauth_client).values({
      id,
      clientId: input.clientId,
      clientSecret: null,
      disabled: false,
      scopes: [...input.scopes],
      userId: null,
      createdAt: now,
      updatedAt: now,
      name: input.name,
      uri: input.clientUri ?? null,
      icon: input.logoUri ?? null,
      contacts: input.contacts ? [...input.contacts] : null,
      tos: input.tosUri ?? null,
      policy: input.policyUri ?? null,
      softwareId: input.softwareId ?? null,
      softwareVersion: input.softwareVersion ?? null,
      softwareStatement: input.softwareStatement ?? null,
      redirectUris: [...input.redirectUris],
      postLogoutRedirectUris: input.postLogoutRedirectUris
        ? [...input.postLogoutRedirectUris]
        : null,
      enableEndSession: input.postLogoutRedirectUris
        ? input.postLogoutRedirectUris.length > 0
        : false,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      grantTypes: [...input.grantTypes],
      responseTypes: [...input.responseTypes],
      public: input.isPublic,
      type: input.type ?? null,
      requirePKCE: true,
      referenceId: input.referenceId,
      metadata: null,
    });
    return {
      id,
      clientId: input.clientId,
      clientIdIssuedAt: Math.floor(now.getTime() / 1000),
    };
  }

  /**
   * Resolve the projected `system.connection { kind: "app" }` item id for
   * (spaceId, clientId, authUserId). Single-row lookup via jsonb `->>`
   * predicates on properties. Returns null if no projection row exists.
   */
  async findGrantItemId(opts: {
    spaceId: string | null;
    clientId: string;
    authUserId: string;
  }): Promise<string | null> {
    const spacePredicate =
      opts.spaceId === null
        ? sql`${items.space_id} IS NULL`
        : sql`${items.space_id} = ${opts.spaceId}`;
    const rows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.type, "system.connection"),
          spacePredicate,
          sql`${items.properties}->>'kind' = 'app'`,
          sql`${items.properties}->>'client_id' = ${opts.clientId}`,
          sql`${items.properties}->>'user_id' = ${opts.authUserId}`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Reap grantless DCR clients older than `cutoffIso`. A client is reaped
   * only when it has NO access token, NO refresh token, and NO projected
   * `system.connection { kind: "app" }` item referencing its `client_id`.
   * Conservative by construction — any one grant signal spares the row.
   */
  async deleteGrantlessClientsOlderThan(cutoffIso: string): Promise<number> {
    // `auth_oauth_client.created_at` is a TEXT ISO-8601 column on PG (Better
    // Auth's adapter stores it as text), so compare against the ISO string
    // directly — ISO-8601 UTC sorts lexicographically in chronological order.
    // Binding a Date here makes postgres-js throw on the text column.
    const deleted = await this.db
      .delete(auth_oauth_client)
      .where(
        and(
          sql`${auth_oauth_client.createdAt} IS NOT NULL`,
          sql`${auth_oauth_client.createdAt} < ${cutoffIso}`,
          sql`NOT EXISTS (SELECT 1 FROM ${auth_oauth_access_token} WHERE ${auth_oauth_access_token.clientId} = ${auth_oauth_client.clientId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${auth_oauth_refresh_token} WHERE ${auth_oauth_refresh_token.clientId} = ${auth_oauth_client.clientId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${items} WHERE ${items.type} = 'system.connection' AND ${items.properties}->>'kind' = 'app' AND ${items.properties}->>'client_id' = ${auth_oauth_client.clientId})`,
        ),
      )
      .returning({ id: auth_oauth_client.id });
    return deleted.length;
  }

  // `updateGrantScopes` was dropped. The re-consent path now routes through
  // `storage.items.update` so the projection participates in versions
  // snapshots + publish events like every other item.
  // See `projectGrantOnConsent` in `routes/auth-consent.ts`.

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
    if (!Array.isArray(row.scopes)) return undefined;
    return row.scopes.filter((s): s is string => typeof s === "string");
  }

  /**
   * Targets the same row `getPriorConsent` reads (most recent by
   * `updated_at`) so the read the consent route based its decision on and
   * the write that repairs it can never address different rows.
   * `updated_at` is deliberately left alone: bumping it would reorder the
   * "most recent" selection this method just resolved.
   *
   * The `expectedScopes` guard rides into the UPDATE's WHERE clause as the
   * array the row currently holds, so the row is only rewritten if it
   * still holds what the caller thinks it does. A grant narrowed or
   * revoked while the caller was deciding is left as the user left it.
   */
  async setConsentScopes(
    clientId: string,
    authUserId: string,
    scopes: readonly string[],
    expectedScopes: readonly string[],
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: auth_oauth_consent.id, scopes: auth_oauth_consent.scopes })
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
    if (!row || !Array.isArray(row.scopes)) return false;
    const current = row.scopes.filter(
      (s): s is string => typeof s === "string",
    );
    if (!sameScopeSet(current, expectedScopes)) return false;
    const updated = await this.db
      .update(auth_oauth_consent)
      .set({ scopes: [...scopes] })
      .where(
        and(
          eq(auth_oauth_consent.id, row.id),
          eq(auth_oauth_consent.scopes, row.scopes),
        ),
      )
      .returning({ id: auth_oauth_consent.id });
    return updated.length > 0;
  }
}
