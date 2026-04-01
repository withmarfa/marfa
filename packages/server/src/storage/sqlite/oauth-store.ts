import { eq, and, isNull } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { OAuthClient, OAuthGrant, OAuthToken, OAuthCode, OAuthTokenType } from "@myme/shared";
import type { OAuthStore } from "../interface.js";
import { oauthClients, oauthGrants, oauthTokens, oauthCodes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteOAuthStore implements OAuthStore {
  constructor(private db: DrizzleDb) {}

  // -----------------------------------------------------------------------
  // Clients
  // -----------------------------------------------------------------------

  async createClient(input: { name: string; redirect_uris: string[] }): Promise<OAuthClient> {
    const now = new Date().toISOString();
    const id = generateId();
    this.db.insert(oauthClients).values({
      id,
      name: input.name,
      redirect_uris: JSON.stringify(input.redirect_uris),
      created_at: now,
    }).run();
    return { id, name: input.name, redirect_uris: input.redirect_uris, created_at: now };
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    const row = this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
    if (!row) return null;
    return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
  }

  async listClients(): Promise<OAuthClient[]> {
    const rows = this.db.select().from(oauthClients).all();
    return rows.map((r) => ({ ...r, redirect_uris: JSON.parse(r.redirect_uris) as string[] }));
  }

  // -----------------------------------------------------------------------
  // Grants
  // -----------------------------------------------------------------------

  async createGrant(clientId: string, scopes: string[]): Promise<OAuthGrant> {
    const now = new Date().toISOString();
    const id = generateId();
    this.db.insert(oauthGrants).values({
      id,
      client_id: clientId,
      scopes: JSON.stringify(scopes),
      created_at: now,
    }).run();
    return { id, client_id: clientId, scopes, created_at: now };
  }

  async getGrantsByClient(clientId: string): Promise<OAuthGrant[]> {
    const rows = this.db.select().from(oauthGrants).where(eq(oauthGrants.client_id, clientId)).all();
    return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] }));
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
    this.db.insert(oauthCodes).values({
      id,
      grant_id: grantId,
      code_hash: codeHash,
      code_challenge: challenge,
      code_challenge_method: method,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
      created_at: now,
    }).run();
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

  async consumeCode(codeHash: string): Promise<(OAuthCode & { scopes: string[] }) | null> {
    const row = this.db.select().from(oauthCodes).where(eq(oauthCodes.code_hash, codeHash)).get();
    if (!row) return null;
    if (row.used_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Atomically mark as used
    this.db.update(oauthCodes)
      .set({ used_at: new Date().toISOString() })
      .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.used_at)))
      .run();

    // Fetch grant scopes
    const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grant_id)).get();
    const scopes = grant ? (JSON.parse(grant.scopes) as string[]) : [];

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

    // Fetch grant scopes
    const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).get();
    const scopes = grant ? (JSON.parse(grant.scopes) as string[]) : [];

    this.db.insert(oauthTokens).values({
      id,
      grant_id: grantId,
      token_hash: tokenHash,
      token_type: type,
      expires_at: expiresAt,
      created_at: now,
    }).run();

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

  async validateToken(tokenHash: string): Promise<(OAuthToken & { scopes: string[] }) | null> {
    const row = this.db.select().from(oauthTokens).where(eq(oauthTokens.token_hash, tokenHash)).get();
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Fetch grant scopes
    const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grant_id)).get();
    const scopes = grant ? (JSON.parse(grant.scopes) as string[]) : [];

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
    const rows = this.db.select().from(oauthTokens).where(isNull(oauthTokens.revoked_at)).all();
    const result: OAuthToken[] = [];
    for (const row of rows) {
      const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grant_id)).get();
      const scopes = grant ? (JSON.parse(grant.scopes) as string[]) : [];
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
    this.db.update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.id, id))
      .run();
  }

  async reduceTokenScope(id: string, scopes: string[]): Promise<void> {
    // Reduce scope by updating the grant's scopes to the intersection
    const token = this.db.select().from(oauthTokens).where(eq(oauthTokens.id, id)).get();
    if (!token) return;

    const grant = this.db.select().from(oauthGrants).where(eq(oauthGrants.id, token.grant_id)).get();
    if (!grant) return;

    const currentScopes = JSON.parse(grant.scopes) as string[];
    const reduced = currentScopes.filter((s) => scopes.includes(s));

    this.db.update(oauthGrants)
      .set({ scopes: JSON.stringify(reduced) })
      .where(eq(oauthGrants.id, token.grant_id))
      .run();
  }

  // -----------------------------------------------------------------------
  // Refresh rotation
  // -----------------------------------------------------------------------

  async markRefreshUsed(id: string): Promise<boolean> {
    const row = this.db.select().from(oauthTokens).where(eq(oauthTokens.id, id)).get();
    if (!row) return false;
    if (row.used_at) return false; // Already used — replay detected

    this.db.update(oauthTokens)
      .set({ used_at: new Date().toISOString() })
      .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.used_at)))
      .run();
    return true;
  }

  async revokeGrantTokens(grantId: string): Promise<void> {
    this.db.update(oauthTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(oauthTokens.grant_id, grantId))
      .run();
  }
}
