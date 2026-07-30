import { eq, and } from "drizzle-orm";
import type { InboundWebhookRow, InboundWebhookStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { inboundWebhooks } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToInboundWebhook(
  row: typeof inboundWebhooks.$inferSelect,
): InboundWebhookRow {
  return {
    id: row.id,
    space_id: row.space_id,
    connection_id: row.connection_id,
    external_service_id: row.external_service_id,
    secret_encrypted: row.secret_encrypted,
    verification_method: row.verification_method,
    verification_adapter_id: row.verification_adapter_id,
    events: safeJsonParse<string[]>(row.events, [], "inbound webhook events"),
    disabled: row.disabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PgInboundWebhookStore implements InboundWebhookStore {
  constructor(private db: PgDb) {}

  async create(input: {
    id: string;
    space_id?: string;
    connection_id: string;
    external_service_id?: string;
    secret_encrypted: string;
    verification_method: string;
    verification_adapter_id?: string;
    events: string[];
  }): Promise<InboundWebhookRow> {
    const now = new Date().toISOString();
    const row = {
      id: input.id,
      space_id: input.space_id ?? null,
      connection_id: input.connection_id,
      external_service_id: input.external_service_id ?? null,
      secret_encrypted: input.secret_encrypted,
      verification_method: input.verification_method,
      verification_adapter_id: input.verification_adapter_id ?? null,
      events: JSON.stringify(input.events),
      disabled: 0,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(inboundWebhooks).values(row);
    return rowToInboundWebhook(row);
  }

  async get(id: string, spaceId?: string): Promise<InboundWebhookRow | null> {
    const conditions = [eq(inboundWebhooks.id, id)];
    if (spaceId !== undefined) {
      conditions.push(eq(inboundWebhooks.space_id, spaceId));
    }
    const [row] = await this.db
      .select()
      .from(inboundWebhooks)
      .where(and(...conditions));
    return row ? rowToInboundWebhook(row) : null;
  }

  async getAny(id: string): Promise<InboundWebhookRow | null> {
    const [row] = await this.db
      .select()
      .from(inboundWebhooks)
      .where(eq(inboundWebhooks.id, id));
    return row ? rowToInboundWebhook(row) : null;
  }

  async listByConnection(
    connectionId: string,
    spaceId?: string,
  ): Promise<InboundWebhookRow[]> {
    const conditions = [eq(inboundWebhooks.connection_id, connectionId)];
    if (spaceId !== undefined) {
      conditions.push(eq(inboundWebhooks.space_id, spaceId));
    }
    const rows = await this.db
      .select()
      .from(inboundWebhooks)
      .where(and(...conditions));
    return rows.map(rowToInboundWebhook);
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    await this.db
      .update(inboundWebhooks)
      .set({ disabled: disabled ? 1 : 0, updated_at: new Date().toISOString() })
      .where(eq(inboundWebhooks.id, id));
  }
}
