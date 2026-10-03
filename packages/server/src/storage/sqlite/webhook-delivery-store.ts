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
import {
  CLAIM_LOCK_TTL_MS,
  validWebhookFrame,
} from "../../webhooks/delivery.js";
import { outboundWebhookDeliveries } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

// Success and cancellation no longer need a replay frame. Failed frames
// retain the original retention deadline for explicit owner redelivery.
const SETTLED = { payload: null, webhook_url: null };

// A lapsed claim may still have HTTP in flight. Its outcome must not write
// into a newer claim or an explicitly reopened retry cycle.
function stillPending(id: string, token: string) {
  return and(
    eq(outboundWebhookDeliveries.id, id),
    eq(outboundWebhookDeliveries.status, "pending"),
    eq(outboundWebhookDeliveries.claim_token, token),
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
    status: row.status,
    succeeded: row.status === "success",
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

  async get(webhookId: string, id: string) {
    const row = await this.db
      .select()
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.id, id),
          eq(outboundWebhookDeliveries.webhook_id, webhookId),
        ),
      )
      .get();
    return row ? rowToDelivery(row) : null;
  }
  async reopen(
    webhookId: string,
    id: string,
    url: string,
    now: string,
    cutoff: string | null,
  ) {
    const t = outboundWebhookDeliveries;
    const retained = await this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.webhook_id, webhookId)))
      .get();
    if (!retained?.payload) return null;
    let frame: unknown;
    try {
      frame = JSON.parse(retained.payload);
    } catch {
      return null;
    }
    if (
      typeof frame !== "object" ||
      frame === null ||
      !validWebhookFrame(frame as Record<string, unknown>, retained.event_type)
    )
      return null;
    const rows = await this.db
      .update(t)
      .set({
        status: "pending",
        claim_token: null,
        retry_start_attempt: sql`${t.attempt}`,
        webhook_url: url,
        next_attempt_at: now,
      })
      .where(
        and(
          eq(t.id, id),
          eq(t.webhook_id, webhookId),
          eq(t.status, "dead_letter"),
          sql`${t.payload} IS NOT NULL`,
          cutoff === null ? undefined : sql`${t.created_at} >= ${cutoff}`,
        ),
      )
      .returning()
      .all();
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async schedule(entry: {
    webhookId: string;
    eventId: bigint;
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
        event_id: entry.eventId.toString(),
        event_type: entry.eventType,
        status_code: null,
        attempt: 0,
        error: null,
        created_at: new Date().toISOString(),
        next_attempt_at: entry.nextAttemptAt,
        payload: entry.payload,
        webhook_url: entry.webhookUrl,
        retry_start_attempt: 0,
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
      event_id: string;
      event_type: string;
      payload: string | null;
      webhook_url: string | null;
      attempt: number;
      retry_start_attempt: number;
      claim_token: string;
    }>(
      sql`
          UPDATE outbound_webhook_deliveries
          SET next_attempt_at = ${claimExpiry}, claim_token = lower(hex(randomblob(16)))
          WHERE id IN (
            SELECT id FROM outbound_webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at
            LIMIT ${limit}
          )
          RETURNING id, webhook_id, event_id, event_type, payload, webhook_url, attempt, retry_start_attempt, claim_token
        `,
    );
    return rows.map((r) => ({
      id: r.id,
      webhook_id: r.webhook_id,
      event_id: r.event_id,
      event_type: r.event_type,
      payload: r.payload ?? "",
      webhook_url: r.webhook_url ?? "",
      attempt: r.attempt,
      retry_start_attempt: r.retry_start_attempt,
      claim_token: r.claim_token,
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
      event_id: string;
      event_type: string;
      payload: string | null;
      webhook_url: string | null;
      attempt: number;
      retry_start_attempt: number;
      claim_token: string;
    }>(
      sql`
          UPDATE outbound_webhook_deliveries
          SET next_attempt_at = ${claimExpiry}, claim_token = lower(hex(randomblob(16)))
          WHERE id = ${id}
            AND status = 'pending'
            AND next_attempt_at <= ${now}
          RETURNING id, webhook_id, event_id, event_type, payload, webhook_url, attempt, retry_start_attempt, claim_token
        `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      webhook_id: row.webhook_id,
      event_id: row.event_id,
      event_type: row.event_type,
      payload: row.payload ?? "",
      webhook_url: row.webhook_url ?? "",
      attempt: row.attempt,
      retry_start_attempt: row.retry_start_attempt,
      claim_token: row.claim_token,
    };
  }

  async markSuccess(
    id: string,
    token: string,
    statusCode: number,
    attempt: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "success",
        claim_token: null,
        error: null,
        status_code: statusCode,
        attempt,
        ...SETTLED,
      })
      .where(stillPending(id, token))
      .run();
    return result.rowsAffected > 0;
  }

  async markFailed(
    id: string,
    token: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<boolean> {
    const result = await this.db
      .update(outboundWebhookDeliveries)
      .set({
        claim_token: null,
        status_code: statusCode ?? null,
        error,
        attempt,
        next_attempt_at: nextAttemptAt,
        status: nextAttemptAt === null ? "dead_letter" : "pending",
      })
      .where(stillPending(id, token))
      .run();
    return result.rowsAffected > 0;
  }

  async markCanceled(
    id: string,
    token: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "canceled",
        claim_token: null,
        error: reason,
        next_attempt_at: null,
        ...SETTLED,
      })
      .where(stillPending(id, token))
      .run();
    return result.rowsAffected > 0;
  }

  async cancelPending(webhookId: string, reason: string): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        status: "canceled",
        claim_token: null,
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
