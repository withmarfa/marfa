import { eq, desc, sql } from "drizzle-orm";
import type { InboundWebhookEvent } from "@mymehq/shared";
import type { InboundWebhookEventStore } from "../interface.js";
import { inboundWebhookEvents } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToEvent(
  row: typeof inboundWebhookEvents.$inferSelect,
): InboundWebhookEvent {
  return {
    id: row.id,
    inbound_webhook_id: row.inbound_webhook_id,
    external_delivery_id: row.external_delivery_id,
    received_at: row.received_at,
    payload: row.payload,
    verified: row.verified === 1,
    processed_at: row.processed_at,
    processing_error: row.processing_error,
    retry_count: row.retry_count,
    next_attempt_at: row.next_attempt_at,
  };
}

export class SqliteInboundWebhookEventStore implements InboundWebhookEventStore {
  constructor(private db: DrizzleDb) {}

  async insert(input: {
    id: string;
    inbound_webhook_id: string;
    external_delivery_id: string;
    received_at: string;
    payload: string;
    verified: boolean;
    processing_error?: string;
  }): Promise<{ id: string; inserted: boolean }> {
    // INSERT ... ON CONFLICT DO NOTHING is the cross-dialect-friendly way
    // to express "insert if not duplicate, else no-op". The unique
    // (inbound_webhook_id, external_delivery_id) constraint catches
    // dup-replays. RETURNING surfaces the inserted row's id; on
    // conflict the result is empty and we look up the existing row.
    const inserted = await this.db
      .insert(inboundWebhookEvents)
      .values({
        id: input.id,
        inbound_webhook_id: input.inbound_webhook_id,
        external_delivery_id: input.external_delivery_id,
        received_at: input.received_at,
        payload: input.payload,
        verified: input.verified ? 1 : 0,
        processing_error: input.processing_error ?? null,
        // verified-but-not-processed-yet rows live in the pending
        // partial-index window. Only set next_attempt_at when verified
        // — failed verifications are kept for audit but don't queue.
        next_attempt_at: input.verified ? input.received_at : null,
      })
      .onConflictDoNothing()
      .returning({ id: inboundWebhookEvents.id })
      .all();

    const insertedId = inserted[0]?.id;
    if (insertedId !== undefined) {
      return { id: insertedId, inserted: true };
    }

    // Conflict path: look up the existing row id for the dedup pair.
    const existing = await this.db
      .select({ id: inboundWebhookEvents.id })
      .from(inboundWebhookEvents)
      .where(
        sql`${inboundWebhookEvents.inbound_webhook_id} = ${input.inbound_webhook_id}
            AND ${inboundWebhookEvents.external_delivery_id} = ${input.external_delivery_id}`,
      )
      .get();
    return {
      id: existing?.id ?? input.id,
      inserted: false,
    };
  }

  async list(
    inboundWebhookId: string,
    limit = 50,
  ): Promise<InboundWebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(inboundWebhookEvents)
      .where(eq(inboundWebhookEvents.inbound_webhook_id, inboundWebhookId))
      .orderBy(desc(inboundWebhookEvents.received_at))
      .limit(limit)
      .all();
    return rows.map(rowToEvent);
  }

  async get(id: string): Promise<InboundWebhookEvent | null> {
    const row = await this.db
      .select()
      .from(inboundWebhookEvents)
      .where(eq(inboundWebhookEvents.id, id))
      .get();
    return row ? rowToEvent(row) : null;
  }

  async resetForRetry(id: string, nextAttemptAt: string): Promise<void> {
    await this.db
      .update(inboundWebhookEvents)
      .set({
        retry_count: 0,
        processing_error: null,
        next_attempt_at: nextAttemptAt,
      })
      .where(eq(inboundWebhookEvents.id, id))
      .run();
  }
}
