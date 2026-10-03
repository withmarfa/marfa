/**
 * The store over the @better-auth/oauth-provider plugin's tables. See
 * `interface.ts` (`OauthProviderStore`) for the contract.
 */

import {
  eq,
  and,
  desc,
  lt,
  isNotNull,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import { safeJsonParse } from "../json-utils.js";
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
  auth_oauth_device_code,
  outboundWebhooks,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { WriteTracker } from "../write-tracker.js";
import { isPublicClient } from "../oauth-client-trust.js";
import { sameScopeSet } from "../consent-scopes.js";

export class SqliteOauthProviderStore implements OauthProviderStore {
  constructor(private db: DrizzleDb) {}

  /**
   * In-flight tracking for the fire-and-forget `last_used_at` stamp. The
   * bearer middleware fires the stamp after the response and nothing
   * awaits it, so without tracking a stamp still in flight when the
   * connection closes surfaces as an unhandled rejection. Same shape as
   * the audit store's drain.
   */
  private readonly stamps = new WriteTracker("oauth-grant-stamp");

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

  drain(): Promise<void> {
    return this.stamps.drain();
  }

  /**
   * `json_set` merges `last_used_at` into the `properties` blob in place,
   * and `json_extract` reads the existing value for the conditional check.
   * ISO-8601 timestamps sort correctly as text, so the comparison is a
   * plain `<`.
   */
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

  async findDeviceCodeGrantKey(deviceCode: string): Promise<{
    clientId: string;
    userId: string;
    hasConsent: boolean;
  } | null> {
    // Only an approved code has a grant to be judged against: a pending one
    // is still the plugin's to answer (`authorization_pending`, or nothing
    // at all once it is claimed but not yet approved), and a denied one is
    // its `access_denied`.
    //
    // The consent row and the projection both, on both of the projection's
    // lifecycle axes: a `system.*` soft delete lands the item on `revoked`
    // and touches nothing inside `properties`, and a purge removes it while
    // the consent row stands, and a grant no person can reach through the
    // interface built for revoking it is not one a code may mint against.
    const rows = await this.db.all<{
      client_id: string | null;
      user_id: string | null;
      consent_id: string | null;
      grant_id: string | null;
    }>(sql`
      SELECT COALESCE(d.oauth_client_id, d.client_id) AS client_id,
             d.user_id                                 AS user_id,
             c.id                                      AS consent_id,
             i.id                                      AS grant_id
      FROM auth_oauth_device_code d
      LEFT JOIN auth_oauth_consent c
        ON c.client_id = COALESCE(d.oauth_client_id, d.client_id)
       AND c.user_id   = d.user_id
      LEFT JOIN items i
        ON i.type = 'system.connection'
       AND i.state = 'active'
       AND json_extract(i.properties, '$.kind') = 'app'
       AND json_extract(i.properties, '$.status') = 'active'
       AND json_extract(i.properties, '$.client_id') = COALESCE(d.oauth_client_id, d.client_id)
       AND json_extract(i.properties, '$.user_id') = d.user_id
      WHERE d.device_code = ${deviceCode}
        AND d.status = 'approved'
      LIMIT 1
    `);
    const row = rows[0];
    if (!row?.client_id || !row.user_id) return null;
    return {
      clientId: row.client_id,
      userId: row.user_id,
      hasConsent: row.consent_id != null && row.grant_id != null,
    };
  }

  async narrowDeviceCodeScope(
    userCode: string,
    scopes: readonly string[],
  ): Promise<boolean> {
    const result = await this.db
      .update(auth_oauth_device_code)
      .set({ scope: scopes.join(" ") })
      .where(
        and(
          eq(auth_oauth_device_code.userCode, userCode),
          eq(auth_oauth_device_code.status, "pending"),
        ),
      )
      .run();
    return result.rowsAffected > 0;
  }

  async deleteDeviceCodesForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM auth_oauth_device_code
      WHERE user_id = ${authUserId}
        AND COALESCE(oauth_client_id, client_id) = ${clientId}
    `);
  }

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
    return this.unrevokedAccessToken(
      eq(auth_oauth_access_token.token, tokenHash),
      true,
    );
  }

  async getAccessTokenById(id: string): Promise<OauthAccessTokenRow | null> {
    return this.unrevokedAccessToken(eq(auth_oauth_access_token.id, id), false);
  }

  private async unrevokedAccessToken(
    where: SQL,
    honorExpiry: boolean,
  ): Promise<OauthAccessTokenRow | null> {
    const rows = await this.db
      .select({
        id: auth_oauth_access_token.id,
        userId: auth_oauth_access_token.userId,
        clientId: auth_oauth_access_token.clientId,
        scopes: auth_oauth_access_token.scopes,
        expiresAt: auth_oauth_access_token.expiresAt,
        createdAt: auth_oauth_access_token.createdAt,
        revoked: auth_oauth_access_token.revoked,
      })
      .from(auth_oauth_access_token)
      .where(where)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // A revoked token is dead whatever its expiry says. The plugin stamps
    // this column when the session it was issued under ends, so signing out
    // is what usually sets it; consulting the clock alone would keep an app
    // working on its stored bearer after the person had signed out.
    if (row.revoked !== null) return null;
    // Expired tokens return null — fail closed.
    const expMs = row.expiresAt ? row.expiresAt.getTime() : null;
    if (honorExpiry && expMs !== null && expMs < Date.now()) return null;
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
        public: auth_oauth_client.public,
        tokenEndpointAuthMethod: auth_oauth_client.tokenEndpointAuthMethod,
        scopes: auth_oauth_client.scopes,
        grantTypes: auth_oauth_client.grantTypes,
      })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // A NULL column means "no ceiling"; a stored array — including an empty
    // one — is a real ceiling. Never collapse the two (see
    // `OauthClientRow.scopes`). Anything that does not parse to an array is
    // treated as absent rather than empty: an unreadable ceiling must not
    // silently become one that permits nothing.
    const parsedScopes =
      row.scopes === null
        ? null
        : safeJsonParse<unknown>(row.scopes, null, "auth_oauth_client.scopes");
    const scopes = Array.isArray(parsedScopes)
      ? parsedScopes.filter((s): s is string => typeof s === "string")
      : null;
    // Same null-versus-empty reading as `scopes` above.
    const parsedGrantTypes =
      row.grantTypes === null
        ? null
        : safeJsonParse<unknown>(
            row.grantTypes,
            null,
            "auth_oauth_client.grant_types",
          );
    const grantTypes = Array.isArray(parsedGrantTypes)
      ? parsedGrantTypes.filter((s): s is string => typeof s === "string")
      : null;
    const parsed = safeJsonParse<unknown>(
      row.redirectUris,
      [],
      "auth_oauth_client.redirect_uris",
    );
    const redirectUris = Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
    const parsedPostLogoutRedirectUris = safeJsonParse<unknown>(
      row.postLogoutRedirectUris ?? "[]",
      [],
      "auth_oauth_client.post_logout_redirect_uris",
    );
    const postLogoutRedirectUris = Array.isArray(parsedPostLogoutRedirectUris)
      ? parsedPostLogoutRedirectUris.filter(
          (s): s is string => typeof s === "string",
        )
      : [];
    return {
      id: row.id,
      clientId: row.clientId,
      name: row.name,
      redirectUris,
      postLogoutRedirectUris,
      isPublic: isPublicClient(row.public, row.tokenEndpointAuthMethod),
      scopes,
      grantTypes,
    };
  }

  async widenClientScopes(
    clientId: string,
    expectedScopes: readonly string[],
    scopes: readonly string[],
  ): Promise<boolean> {
    // Read to compare, then re-state the value read in the UPDATE's own
    // WHERE, which is what makes this a compare-and-swap rather than a
    // check followed by a hope. `setConsentScopes` below does the same, and
    // for the same reason: two authorize requests for one client can be in
    // flight together, and a registration update can land between the read
    // and the write. Comparing in application code alone loses that race
    // silently, last write winning.
    const rows = await this.db
      .select({ id: auth_oauth_client.id, scopes: auth_oauth_client.scopes })
      .from(auth_oauth_client)
      .where(eq(auth_oauth_client.clientId, clientId))
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    const raw = row.scopes;
    if (raw === null) return false;
    const parsed = safeJsonParse<unknown>(
      raw,
      null,
      "auth_oauth_client.scopes",
    );
    const held = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : null;
    if (held === null) return false;
    // Ordered, not a set compare: the caller passes the exact array it read
    // and appends to, so anything else is a row that has moved.
    if (
      held.length !== expectedScopes.length ||
      held.some((s, i) => s !== expectedScopes[i])
    ) {
      return false;
    }
    const updated = await this.db
      .update(auth_oauth_client)
      .set({ scopes: JSON.stringify([...scopes]), updatedAt: new Date() })
      .where(
        and(
          eq(auth_oauth_client.id, row.id),
          eq(auth_oauth_client.scopes, raw),
        ),
      )
      .returning({ id: auth_oauth_client.id });
    return updated.length > 0;
  }

  async setRegisteredScopes(
    clientId: string,
    scopes: readonly string[],
  ): Promise<boolean> {
    const updated = await this.db
      .update(auth_oauth_client)
      .set({ scopes: JSON.stringify([...scopes]), updatedAt: new Date() })
      .where(eq(auth_oauth_client.clientId, clientId))
      .returning({ id: auth_oauth_client.id });
    return updated.length > 0;
  }

  async revokeTokensForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // access_token.refresh_id has a nullable FK — delete both explicitly.
      await tx
        .delete(auth_oauth_access_token)
        .where(
          and(
            eq(auth_oauth_access_token.clientId, clientId),
            eq(auth_oauth_access_token.userId, authUserId),
          ),
        );
      await tx
        .delete(auth_oauth_refresh_token)
        .where(
          and(
            eq(auth_oauth_refresh_token.clientId, clientId),
            eq(auth_oauth_refresh_token.userId, authUserId),
          ),
        );
      await tx
        .delete(auth_oauth_consent)
        .where(
          and(
            eq(auth_oauth_consent.clientId, clientId),
            eq(auth_oauth_consent.userId, authUserId),
          ),
        );
      // A grant's webhook subscriptions go with its consent: a subscription
      // is matched to its grant by app and person, so one left standing
      // would be the next grant's when the same person reconnects the app.
      await tx
        .delete(outboundWebhooks)
        .where(
          and(
            eq(outboundWebhooks.grant_client_id, clientId),
            eq(outboundWebhooks.grant_user_id, authUserId),
          ),
        );
      await this.revokeAuthorizationCodesForGrant(clientId, authUserId);
    });
  }

  async findAuthorizationCodeGrantKey(codeHash: string): Promise<{
    clientId: string;
    userId: string;
    hasConsent: boolean;
  } | null> {
    const rows = await this.db.all<{
      client_id: string | null;
      user_id: string | null;
      consent_id: string | null;
    }>(sql`
      SELECT json_extract(v.value, '$.query.client_id') AS client_id,
             json_extract(v.value, '$.userId')          AS user_id,
             c.id                                        AS consent_id
      FROM auth_verification v
      LEFT JOIN auth_oauth_consent c
        ON c.client_id = json_extract(v.value, '$.query.client_id')
       AND c.user_id   = json_extract(v.value, '$.userId')
      WHERE v.identifier = ${codeHash}
        AND json_extract(v.value, '$.type') = 'authorization_code'
      LIMIT 1
    `);
    const row = rows[0];
    if (!row?.client_id || !row.user_id) return null;
    return {
      clientId: row.client_id,
      userId: row.user_id,
      hasConsent: row.consent_id != null,
    };
  }

  async revokeAuthorizationCodesForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void> {
    // Authorization codes are not in the plugin's own tables. They live as
    // `auth_verification` rows whose `value` is a JSON blob carrying the
    // grant they belong to, so reaching them means querying inside it.
    await this.db.run(sql`
      DELETE FROM auth_verification
      WHERE json_extract(value, '$.type') = 'authorization_code'
        AND json_extract(value, '$.query.client_id') = ${clientId}
        AND json_extract(value, '$.userId') = ${authUserId}
    `);
  }

  /**
   * Delete ONLY access tokens for a grant; leaves refresh tokens + consent
   * intact. The plugin's own deleteMany on stale-refresh handles refresh-token
   * cleanup — this complements by revoking access tokens issued from the same
   * poisoned chain.
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
   * compute the same hash to find the row. Returns null if the token
   * doesn't exist (e.g. cleaned up by a prior pass).
   */
  async findRefreshTokenGrantKey(tokenHash: string): Promise<{
    clientId: string;
    userId: string;
    revoked: boolean;
  } | null> {
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
    const now = new Date();
    const accessExpires = new Date(now.getTime() + input.accessTtlMs);
    const refreshExpires = new Date(now.getTime() + 30 * 86_400_000); // 30-day TTL matches plugin default
    const scopesJson = JSON.stringify(input.scopes);
    // No refresh hash means an access token on its own; `refresh_id` is
    // nullable precisely so an access token can stand alone.
    let refreshId: string | null = null;
    if (input.refreshTokenHash !== undefined) {
      refreshId = generateId();
      await this.db.insert(auth_oauth_refresh_token).values({
        id: refreshId,
        token: input.refreshTokenHash,
        clientId: input.clientId,
        userId: input.authUserId,
        expiresAt: refreshExpires,
        createdAt: now,
        scopes: scopesJson,
      });
    }
    await this.db.insert(auth_oauth_access_token).values({
      id: generateId(),
      token: input.accessTokenHash,
      clientId: input.clientId,
      userId: input.authUserId,
      refreshId,
      expiresAt: accessExpires,
      createdAt: now,
      scopes: scopesJson,
    });
  }

  async createClient(input: CreateClientInput): Promise<CreateClientResult> {
    const id = generateId();
    const now = new Date();
    // JSON-encode every string[] field: the columns are `text` holding JSON
    // literals, which is what every reader here parses back.
    await this.db.insert(auth_oauth_client).values({
      id,
      clientId: input.clientId,
      clientSecret: null,
      disabled: false,
      // `JSON.stringify(null)` is the four-character string `"null"`, which
      // is a present value, not an absent one — the plugin's
      // `client.scopes ?? opts.scopes` would never fall through and the
      // ceiling would be whatever that string parses to. Write SQL NULL.
      scopes: input.scopes === null ? null : JSON.stringify(input.scopes),
      userId: null,
      createdAt: now,
      updatedAt: now,
      name: input.name,
      uri: input.clientUri ?? null,
      icon: input.logoUri ?? null,
      contacts: input.contacts ? JSON.stringify(input.contacts) : null,
      tos: input.tosUri ?? null,
      policy: input.policyUri ?? null,
      softwareId: input.softwareId ?? null,
      softwareVersion: input.softwareVersion ?? null,
      softwareStatement: input.softwareStatement ?? null,
      redirectUris: JSON.stringify(input.redirectUris),
      postLogoutRedirectUris: input.postLogoutRedirectUris
        ? JSON.stringify(input.postLogoutRedirectUris)
        : null,
      enableEndSession: input.postLogoutRedirectUris
        ? input.postLogoutRedirectUris.length > 0
        : false,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      grantTypes: JSON.stringify(input.grantTypes),
      responseTypes: JSON.stringify(input.responseTypes),
      public: input.isPublic,
      type: input.type ?? null,
      requirePKCE: true,
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
   * (clientId, authUserId). Single-row lookup via json_extract
   * predicates on properties. Returns null if no projection row exists.
   *
   * **`state = 'active'` is part of the identity, not a filter.** Every
   * caller either re-establishes the grant, stamps it, or names it in an
   * audit row, and each of those describes a record a person is supposed to
   * be able to find and disconnect. The two surfaces that offer that button
   * — `GET /grants` and the security page — list a row only when its `state`
   * is active AND its `properties.status` is active, so a row failing
   * either axis is beyond every revoke interface the product has.
   *
   * Without this predicate the lookup would hand such a row back and the
   * re-consent branch would flip `properties.status` to active while
   * leaving `state` alone, so a grant could sit at `state: revoked` beside
   * `status: active`: listed by neither surface, and still good enough for
   * the device token step to mint against. `DELETE /items/{id}` produces
   * that shape on its own, because `softDeleteState` resolves `revoked`
   * rather than `trashed` for a `system.*` type and a soft delete does not
   * touch properties, and `items.get` hides only `trashed`.
   *
   * Refusing the row here rather than in the route is what makes the two
   * re-consent paths agree: the device flow and the code flow both resolve
   * through this method, so a fix in one route would have left the other
   * holding the same defect. It also leaves the revoked grant row alone — a lookup
   * that cannot see it is a lookup that cannot resurrect it, and the fresh
   * insert every caller falls through to is the only remaining branch.
   */
  async findGrantItemId(opts: {
    clientId: string;
    authUserId: string;
  }): Promise<string | null> {
    const rows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.type, "system.connection"),
          eq(items.state, "active"),
          sql`json_extract(${items.properties}, '$.kind') = 'app'`,
          sql`json_extract(${items.properties}, '$.client_id') = ${opts.clientId}`,
          sql`json_extract(${items.properties}, '$.user_id') = ${opts.authUserId}`,
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
   *
   * `createdAt` is stored as Unix seconds (`integer mode:timestamp`); the
   * Drizzle `lt(column, Date)` operator handles the Date → epoch-seconds
   * coercion so the cutoff comparison stays correct.
   */
  async deleteGrantlessClientsOlderThan(cutoffIso: string): Promise<number> {
    const cutoff = new Date(cutoffIso);
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: auth_oauth_client.id })
        .from(auth_oauth_client)
        .where(
          and(
            isNotNull(auth_oauth_client.createdAt),
            lt(auth_oauth_client.createdAt, cutoff),
            sql`NOT EXISTS (SELECT 1 FROM ${auth_oauth_access_token} WHERE ${auth_oauth_access_token.clientId} = ${auth_oauth_client.clientId})`,
            sql`NOT EXISTS (SELECT 1 FROM ${auth_oauth_refresh_token} WHERE ${auth_oauth_refresh_token.clientId} = ${auth_oauth_client.clientId})`,
            sql`NOT EXISTS (SELECT 1 FROM ${items} WHERE ${items.type} = 'system.connection' AND json_extract(${items.properties}, '$.kind') = 'app' AND json_extract(${items.properties}, '$.client_id') = ${auth_oauth_client.clientId})`,
          ),
        )
        .orderBy(auth_oauth_client.id)
        .limit(200);
      if (candidates.length === 0) return 0;
      const deleted = await tx
        .delete(auth_oauth_client)
        .where(
          inArray(
            auth_oauth_client.id,
            candidates.map((row) => row.id),
          ),
        )
        .returning({ id: auth_oauth_client.id });
      return deleted.length;
    });
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
    const parsed = safeJsonParse<unknown>(
      row.scopes,
      [],
      "auth_oauth_consent.scopes",
    );
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((s): s is string => typeof s === "string");
  }

  /**
   * Targets the same row `getPriorConsent` reads (most recent by
   * `updated_at`) so the read the consent route based its decision on and
   * the write that repairs it can never address different rows.
   * `updated_at` is deliberately left alone: bumping it would reorder the
   * "most recent" selection this method just resolved.
   *
   * The `expectedScopes` guard rides into the UPDATE's WHERE clause as the
   * raw stored value, so the row is only rewritten if it still holds what
   * the caller thinks it does. A grant narrowed or revoked while the
   * caller was deciding is left as the user left it.
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
    if (!row) return false;
    const current = safeJsonParse<unknown>(
      row.scopes,
      [],
      "auth_oauth_consent.scopes",
    );
    if (!Array.isArray(current)) return false;
    if (
      !sameScopeSet(
        current.filter((s): s is string => typeof s === "string"),
        expectedScopes,
      )
    ) {
      return false;
    }
    const result = await this.db
      .update(auth_oauth_consent)
      .set({ scopes: JSON.stringify([...scopes]) })
      .where(
        and(
          eq(auth_oauth_consent.id, row.id),
          eq(auth_oauth_consent.scopes, row.scopes),
        ),
      );
    return result.rowsAffected > 0;
  }

  async upsertConsent(input: {
    clientId: string;
    authUserId: string;
    scopes: readonly string[];
  }): Promise<void> {
    const now = new Date();
    // One statement, arbitrated by `uq_auth_oauth_consent_client_user`.
    await this.db
      .insert(auth_oauth_consent)
      .values({
        id: generateId(),
        clientId: input.clientId,
        userId: input.authUserId,
        scopes: JSON.stringify([...input.scopes]),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [auth_oauth_consent.clientId, auth_oauth_consent.userId],
        set: {
          scopes: JSON.stringify([...input.scopes]),
          updatedAt: now,
        },
      });
  }
}
