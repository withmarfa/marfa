import { eq, and } from "drizzle-orm";
import type { InboundWebhookRow, InboundWebhookStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { inboundWebhooks } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToInboundWebhook(
  row: typeof inboundWebhooks.$inferSelect,
): InboundWebhookRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
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

export class SqliteInboundWebhookStore implements InboundWebhookStore {
  constructor(private db: DrizzleDb) {}

  create(input: {
    id: string;
    tenant_id?: string;
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
      tenant_id: input.tenant_id ?? null,
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
    this.db.insert(inboundWebhooks).values(row).run();
    return Promise.resolve(rowToInboundWebhook(row));
  }

  get(id: string, tenantId?: string): Promise<InboundWebhookRow | null> {
    const conditions = [eq(inboundWebhooks.id, id)];
    if (tenantId !== undefined) {
      conditions.push(eq(inboundWebhooks.tenant_id, tenantId));
    }
    const row = this.db
      .select()
      .from(inboundWebhooks)
      .where(and(...conditions))
      .get();
    return Promise.resolve(row ? rowToInboundWebhook(row) : null);
  }

  getAny(id: string): Promise<InboundWebhookRow | null> {
    const row = this.db
      .select()
      .from(inboundWebhooks)
      .where(eq(inboundWebhooks.id, id))
      .get();
    return Promise.resolve(row ? rowToInboundWebhook(row) : null);
  }

  listByConnection(
    connectionId: string,
    tenantId?: string,
  ): Promise<InboundWebhookRow[]> {
    const conditions = [eq(inboundWebhooks.connection_id, connectionId)];
    if (tenantId !== undefined) {
      conditions.push(eq(inboundWebhooks.tenant_id, tenantId));
    }
    const rows = this.db
      .select()
      .from(inboundWebhooks)
      .where(and(...conditions))
      .all();
    return Promise.resolve(rows.map(rowToInboundWebhook));
  }

  setDisabled(id: string, disabled: boolean): Promise<void> {
    this.db
      .update(inboundWebhooks)
      .set({ disabled: disabled ? 1 : 0, updated_at: new Date().toISOString() })
      .where(eq(inboundWebhooks.id, id))
      .run();
    return Promise.resolve();
  }
}
