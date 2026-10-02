import { and, eq, desc, isNull, lt, ne, or, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { PaginatedResult, WebhookDelivery } from "@withmarfa/shared";
import {
  WEBHOOK_DELIVERIES_CURSOR_KEY,
  decodeKeyedCursor,
  encodeKeyedCursor,
} from "../interface.js";
import type {
  PendingWebhookDelivery,
  WebhookDeliveryStore,
} from "../interface.js";
import { CLAIM_LOCK_TTL_MS } from "../../webhooks/delivery.js";
import { outboundWebhookDeliveries } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

// Only a retry reads these, and kept on a settled row the event and the
// address would outlive their subscription.
const SETTLED = { payload: null, webhook_url: null };

// The first outcome stands: an attempt whose claim lapsed and was taken
// again must not reopen, or unsettle, what the other attempt settled.
function stillPending(id: string) {
  return and(
    eq(outboundWebhookDeliveries.id, id),
    eq(outboundWebhookDeliveries.status, "pending"),
  );
}

function rowToDelivery(
  row: typeof outboundWebhookDeliveries.$inferSelect,
): WebhookDelivery {
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    status_code: row.status_code ?? null,
    attempt: row.attempt,
    succeeded: row.succeeded === 1,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: DrizzleDb) {}

  async list(
    webhookId: string,
    page: { limit: number; cursor?: string },
  ): Promise<PaginatedResult<WebhookDelivery>> {
    const after =
      page.cursor === undefined
        ? undefined
        : decodeKeyedCursor(page.cursor, WEBHOOK_DELIVERIES_CURSOR_KEY);
    const t = outboundWebhookDeliveries;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.webhook_id, webhookId),
          after === undefined
            ? undefined
            : or(
                lt(t.created_at, after.v),
                and(eq(t.created_at, after.v), lt(t.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(t.created_at), desc(t.id))
      .limit(page.limit + 1)
      .all();
    const slice = rows.slice(0, page.limit);
    const last = slice.at(-1);
    return {
      data: slice.map(rowToDelivery),
      next_cursor:
        rows.length > page.limit && last
          ? encodeKeyedCursor(
              last.created_at,
              last.id,
              WEBHOOK_DELIVERIES_CURSOR_KEY,
            )
          : null,
    };
  }

  async schedule(entry: {
    webhookId: string;
    eventType: string;
    payload: string;
    webhookUrl: string;
    nextAttemptAt: string;
  }): Promise<string> {
    const id = generateId();
    await this.db
      .insert(outboundWebhookDeliveries)
      .values({
        id,
        webhook_id: entry.webhookId,
        event_type: entry.eventType,
        status_code: null,
        attempt: 0,
        succeeded: 0,
        error: null,
        created_at: new Date().toISOString(),
        next_attempt_at: entry.nextAttemptAt,
        payload: entry.payload,
        webhook_url: entry.webhookUrl,
        max_attempts: 4,
        status: "pending",
      })
      .run();
    return id;
  }

  async getPending(now: string, limit = 50): Promise<PendingWebhookDelivery[]> {
    const claimExpiry = new Date(Date.now() + CLAIM_LOCK_TTL_MS).toISOString();
    const rows = await this.db.all<{
      id: string;
      webhook_id: string;
      event_type: string;
      payload: string | null;
      webhook_url: string | null;
      attempt: number;
      max_attempts: number;
    }>(
      sql`
          UPDATE outbound_webhook_deliveries
          SET next_attempt_at = ${claimExpiry}
          WHERE id IN (
            SELECT id FROM outbound_webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at
            LIMIT ${limit}
          )
          RETURNING id, webhook_id, event_type, payload, webhook_url, attempt, max_attempts
        `,
    );
    return rows.map((r) => ({
      id: r.id,
      webhook_id: r.webhook_id,
      event_type: r.event_type,
      payload: r.payload ?? "",
      webhook_url: r.webhook_url ?? "",
      attempt: r.attempt,
      max_attempts: r.max_attempts,
    }));
  }

  /** SQLite takes one writer at a time, so the compare-and-set is
   *  serialized by the statement itself. */
  async claimById(
    id: string,
    claimExpiry: string,
    now: string,
  ): Promise<PendingWebhookDelivery | null> {
    const rows = await this.db.all<{
      id: string;
      webhook_id: string;
      event_type: string;
      payload: string | null;
      webhook_url: string | null;
      attempt: number;
      max_attempts: number;
    }>(
      sql`
          UPDATE outbound_webhook_deliveries
          SET next_attempt_at = ${claimExpiry}
          WHERE id = ${id}
            AND status = 'pending'
            AND next_attempt_at <= ${now}
          RETURNING id, webhook_id, event_type, payload, webhook_url, attempt, max_attempts
        `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      webhook_id: row.webhook_id,
      event_type: row.event_type,
      payload: row.payload ?? "",
      webhook_url: row.webhook_url ?? "",
      attempt: row.attempt,
      max_attempts: row.max_attempts,
    };
  }

  async markSuccess(
    id: string,
    statusCode: number,
    attempt: number,
  ): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "success",
        succeeded: 1,
        status_code: statusCode,
        attempt,
        ...SETTLED,
      })
      .where(stillPending(id))
      .run();
  }

  async markFailed(
    id: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status_code: statusCode ?? null,
        error,
        attempt,
        next_attempt_at: nextAttemptAt,
        status: nextAttemptAt === null ? "dead_letter" : "pending",
        ...(nextAttemptAt === null ? SETTLED : {}),
      })
      .where(stillPending(id))
      .run();
  }

  async markDeadLetter(id: string): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({ status: "dead_letter", ...SETTLED })
      .where(stillPending(id))
      .run();
  }

  async markCancelled(id: string, reason: string): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "cancelled",
        error: reason,
        next_attempt_at: null,
        ...SETTLED,
      })
      .where(stillPending(id))
      .run();
  }

  async cancelPending(webhookId: string, reason: string): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "cancelled",
        error: reason,
        next_attempt_at: null,
        ...SETTLED,
      })
      .where(
        and(
          eq(outboundWebhookDeliveries.webhook_id, webhookId),
          eq(outboundWebhookDeliveries.status, "pending"),
        ),
      )
      .run();
  }

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(outboundWebhookDeliveries)
      .where(
        and(
          lt(outboundWebhookDeliveries.created_at, cutoff),
          // A pending row with no next attempt is one no claim can reach.
          or(
            ne(outboundWebhookDeliveries.status, "pending"),
            isNull(outboundWebhookDeliveries.next_attempt_at),
          ),
        ),
      )
      .run();
    return result.rowsAffected;
  }
}
