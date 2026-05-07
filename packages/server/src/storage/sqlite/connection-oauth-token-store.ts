import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  ConnectionOAuthTokenRow,
  ConnectionOAuthTokenStore,
} from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { connectionOauthTokens } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToToken(
  row: typeof connectionOauthTokens.$inferSelect,
): ConnectionOAuthTokenRow {
  return {
    id: row.id,
    connection_id: row.connection_id,
    tenant_id: row.tenant_id,
    access_token_encrypted: row.access_token_encrypted,
    refresh_token_encrypted: row.refresh_token_encrypted,
    expires_at: row.expires_at,
    scopes: safeJsonParse<string[]>(row.scopes, [], "oauth token scopes"),
    previous_refresh_hash: row.previous_refresh_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteConnectionOAuthTokenStore implements ConnectionOAuthTokenStore {
  constructor(private db: DrizzleDb) {}

  async upsert(input: {
    connection_id: string;
    tenant_id?: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    expires_at: string;
    scopes: string[];
    previous_refresh_hash?: string | null;
  }): Promise<ConnectionOAuthTokenRow> {
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(connectionOauthTokens)
      .where(eq(connectionOauthTokens.connection_id, input.connection_id))
      .get();

    if (existing) {
      const updated = {
        ...existing,
        tenant_id: input.tenant_id ?? existing.tenant_id,
        access_token_encrypted: input.access_token_encrypted,
        refresh_token_encrypted: input.refresh_token_encrypted,
        expires_at: input.expires_at,
        scopes: JSON.stringify(input.scopes),
        previous_refresh_hash:
          input.previous_refresh_hash !== undefined
            ? input.previous_refresh_hash
            : existing.previous_refresh_hash,
        updated_at: now,
      };
      await this.db
        .update(connectionOauthTokens)
        .set(updated)
        .where(eq(connectionOauthTokens.id, existing.id))
        .run();
      return rowToToken(updated);
    }

    const row = {
      id: randomUUID(),
      connection_id: input.connection_id,
      tenant_id: input.tenant_id ?? null,
      access_token_encrypted: input.access_token_encrypted,
      refresh_token_encrypted: input.refresh_token_encrypted,
      expires_at: input.expires_at,
      scopes: JSON.stringify(input.scopes),
      previous_refresh_hash: input.previous_refresh_hash ?? null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(connectionOauthTokens).values(row).run();
    return rowToToken(row);
  }

  async get(
    connectionId: string,
    tenantId?: string,
  ): Promise<ConnectionOAuthTokenRow | null> {
    const conditions = [eq(connectionOauthTokens.connection_id, connectionId)];
    if (tenantId !== undefined) {
      conditions.push(eq(connectionOauthTokens.tenant_id, tenantId));
    }
    const row = await this.db
      .select()
      .from(connectionOauthTokens)
      .where(and(...conditions))
      .get();
    return row ? rowToToken(row) : null;
  }

  async delete(connectionId: string): Promise<void> {
    await this.db
      .delete(connectionOauthTokens)
      .where(eq(connectionOauthTokens.connection_id, connectionId))
      .run();
  }
}
