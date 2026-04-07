import { safeJsonParse } from "../json-utils.js";
import { eq, and, isNull } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type {
  OAuthClient,
  OAuthGrant,
  OAuthToken,
  OAuthCode,
  OAuthTokenType,
} from "@myme/shared";
import type { OAuthStore } from "../interface.js";
import {
  oauthClients,
  oauthGrants,
  oauthTokens,
  oauthCodes,
} from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgOAuthStore implements OAuthStore {
  constructor(private db: PgDb) {}

  // -----------------------------------------------------------------------
  // Clients
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
  // Grants
  // -----------------------------------------------------------------------

  async createGrant(clientId: string, scopes: string[]): Promise<OAuthGrant> {
    const now = new Date().toISOString();
    const id = generateId();
    await this.db.insert(oauthGrants).values({
      id,
      client_id: clientId,
      scopes: JSON.stringify(scopes),
      created_at: now,
    });
    return { id, client_id: clientId, scopes, created_at: now };
  }

  async getGrantsByClient(clientId: string): Promise<OAuthGrant[]> {
    const rows = await this.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.client_id, clientId));
    return rows.map((r) => ({
      ...r,
      scopes: safeJsonParse<string[]>(r.scopes, [], "oauth scopes"),
    }));
  }

  // -----------------------------------------------------------------------
  // Codes
  // -----------------------------------------------------------------------

  async createCode(
    grantId: string,
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
      grant_id: grantId,
      code_hash: codeHash,
      code_challenge: challenge,
      code_challenge_method: method,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
      created_at: now,
    });
    return {
      id,
      grant_id: grantId,
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
    const rows = await this.db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.code_hash, codeHash));
    const row = rows[0];
    if (!row) return null;
    if (row.used_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    await this.db
      .update(oauthCodes)
      .set({ used_at: new Date().toISOString() })
      .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.used_at)));

    const grants = await this.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.id, row.grant_id));
    const grant = grants[0];
    const scopes = grant
      ? safeJsonParse<string[]>(grant.scopes, [], "oauth grant scopes")
      : [];

    return {
      id: row.id,
      grant_id: row.grant_id,
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
    grantId: string,
    tokenHash: string,
    type: OAuthTokenType,
    expiresAt: string,
  ): Promise<OAuthToken> {
    const now = new Date().toISOString();
    const id = generateId();

    const grants = await this.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.id, grantId));
    const grant = grants[0];
    const scopes = grant
      ? safeJsonParse<string[]>(grant.scopes, [], "oauth grant scopes")
      : [];

    await this.db.insert(oauthTokens).values({
      id,
      grant_id: grantId,
      token_hash: tokenHash,
      token_type: type,
      expires_at: expiresAt,
      created_at: now,
    });

    return {
      id,
      grant_id: grantId,
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

    const grants = await this.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.id, row.grant_id));
    const grant = grants[0];
    const scopes = grant
      ? safeJsonParse<string[]>(grant.scopes, [], "oauth grant scopes")
      : [];

    return {
      id: row.id,
      grant_id: row.grant_id,
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
      const grants = await this.db
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.id, row.grant_id));
      const grant = grants[0];
      const scopes = grant
        ? safeJsonParse<string[]>(grant.scopes, [], "oauth grant scopes")
        : [];
      result.push({
        id: row.id,
        grant_id: row.grant_id,
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

    const grantRows = await this.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.id, token.grant_id));
    const grant = grantRows[0];
    if (!grant) return;

    const currentScopes = safeJsonParse<string[]>(
      grant.scopes,
      [],
      "oauth grant scopes",
    );
    const reduced = currentScopes.filter((s) => scopes.includes(s));

    await this.db
      .update(oauthGrants)
      .set({ scopes: JSON.stringify(reduced) })
      .where(eq(oauthGrants.id, token.grant_id));
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

  async revokeGrantTokens(grantId: string): Promise<void> {
    await this.db
      .update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.grant_id, grantId));
  }
}
