import { eq, and, gt, isNull } from "drizzle-orm";
import type {
  ConnectionLeasedTokenRow,
  ConnectionLeasedTokenStore,
} from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { connectionLeasedTokens } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToLease(
  row: typeof connectionLeasedTokens.$inferSelect,
): ConnectionLeasedTokenRow {
  return {
    id: row.id,
    connection_id: row.connection_id,
    tenant_id: row.tenant_id,
    capability_id: row.capability_id,
    lease_token_hash: row.lease_token_hash,
    scopes: safeJsonParse<string[]>(row.scopes, [], "lease scopes"),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    issued_by_key_id: row.issued_by_key_id,
    created_at: row.created_at,
  };
}

export class PgConnectionLeasedTokenStore implements ConnectionLeasedTokenStore {
  constructor(private db: PgDb) {}

  async create(input: {
    id: string;
    connection_id: string;
    tenant_id?: string;
    capability_id: string;
    lease_token_hash: string;
    scopes: string[];
    expires_at: string;
    issued_by_key_id?: string;
  }): Promise<ConnectionLeasedTokenRow> {
    const now = new Date().toISOString();
    const row = {
      id: input.id,
      connection_id: input.connection_id,
      tenant_id: input.tenant_id ?? null,
      capability_id: input.capability_id,
      lease_token_hash: input.lease_token_hash,
      scopes: JSON.stringify(input.scopes),
      expires_at: input.expires_at,
      revoked_at: null,
      issued_by_key_id: input.issued_by_key_id ?? null,
      created_at: now,
    };
    await this.db.insert(connectionLeasedTokens).values(row);
    return rowToLease(row);
  }

  async findByHash(hash: string): Promise<ConnectionLeasedTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(connectionLeasedTokens)
      .where(eq(connectionLeasedTokens.lease_token_hash, hash));
    return row ? rowToLease(row) : null;
  }

  async get(
    id: string,
    tenantId?: string,
  ): Promise<ConnectionLeasedTokenRow | null> {
    const conditions = [eq(connectionLeasedTokens.id, id)];
    if (tenantId !== undefined) {
      conditions.push(eq(connectionLeasedTokens.tenant_id, tenantId));
    }
    const [row] = await this.db
      .select()
      .from(connectionLeasedTokens)
      .where(and(...conditions));
    return row ? rowToLease(row) : null;
  }

  async listActiveByConnection(
    connectionId: string,
    nowIso: string,
    tenantId?: string,
  ): Promise<ConnectionLeasedTokenRow[]> {
    const conditions = [
      eq(connectionLeasedTokens.connection_id, connectionId),
      isNull(connectionLeasedTokens.revoked_at),
      gt(connectionLeasedTokens.expires_at, nowIso),
    ];
    if (tenantId !== undefined) {
      conditions.push(eq(connectionLeasedTokens.tenant_id, tenantId));
    }
    const rows = await this.db
      .select()
      .from(connectionLeasedTokens)
      .where(and(...conditions));
    return rows.map(rowToLease);
  }

  async revoke(id: string, nowIso: string): Promise<boolean> {
    const result = await this.db
      .update(connectionLeasedTokens)
      .set({ revoked_at: nowIso })
      .where(
        and(
          eq(connectionLeasedTokens.id, id),
          isNull(connectionLeasedTokens.revoked_at),
        ),
      )
      .returning({ id: connectionLeasedTokens.id });
    return result.length > 0;
  }
}
