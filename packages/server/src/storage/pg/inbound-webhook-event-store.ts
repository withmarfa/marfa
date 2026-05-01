import { eq, desc, and } from "drizzle-orm";
import type { InboundWebhookEvent } from "@mymehq/shared";
import type { InboundWebhookEventStore } from "../interface.js";
import { inboundWebhookEvents } from "./schema.js";
import type { PgDb } from "./connection.js";

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

export class PgInboundWebhookEventStore implements InboundWebhookEventStore {
  constructor(private db: PgDb) {}

  async insert(input: {
    id: string;
    inbound_webhook_id: string;
    external_delivery_id: string;
    received_at: string;
    payload: string;
    verified: boolean;
    processing_error?: string;
  }): Promise<{ id: string; inserted: boolean }> {
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
        next_attempt_at: input.verified ? input.received_at : null,
      })
      .onConflictDoNothing()
      .returning({ id: inboundWebhookEvents.id });

    const insertedId = inserted[0]?.id;
    if (insertedId !== undefined) {
      return { id: insertedId, inserted: true };
    }

    const [existing] = await this.db
      .select({ id: inboundWebhookEvents.id })
      .from(inboundWebhookEvents)
      .where(
        and(
          eq(inboundWebhookEvents.inbound_webhook_id, input.inbound_webhook_id),
          eq(
            inboundWebhookEvents.external_delivery_id,
            input.external_delivery_id,
          ),
        ),
      );
    return { id: existing?.id ?? input.id, inserted: false };
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
      .limit(limit);
    return rows.map(rowToEvent);
  }

  async get(id: string): Promise<InboundWebhookEvent | null> {
    const [row] = await this.db
      .select()
      .from(inboundWebhookEvents)
      .where(eq(inboundWebhookEvents.id, id));
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
      .where(eq(inboundWebhookEvents.id, id));
  }
}
