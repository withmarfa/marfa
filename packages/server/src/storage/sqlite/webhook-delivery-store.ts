import { eq, desc, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { WebhookDelivery } from "@withmarfa/shared";
import type {
  PendingWebhookDelivery,
  WebhookDeliveryStore,
} from "../interface.js";
import { CLAIM_LOCK_TTL_MS } from "../../webhooks/delivery.js";
import { outboundWebhookDeliveries } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToDelivery(
  row: typeof outboundWebhookDeliveries.$inferSelect,
): WebhookDelivery {
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    event: row.event,
    status_code: row.status_code ?? null,
    attempt: row.attempt,
    succeeded: row.succeeded === 1,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: DrizzleDb) {}

  async log(entry: {
    webhookId: string;
    event: string;
    statusCode?: number;
    attempt: number;
    succeeded: boolean;
    error?: string;
  }): Promise<void> {
    await this.db
      .insert(outboundWebhookDeliveries)
      .values({
        id: generateId(),
        webhook_id: entry.webhookId,
        event: entry.event,
        status_code: entry.statusCode ?? null,
        attempt: entry.attempt,
        succeeded: entry.succeeded ? 1 : 0,
        error: entry.error ?? null,
        created_at: new Date().toISOString(),
      })
      .run();
  }

  async list(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhookDeliveries)
      .where(eq(outboundWebhookDeliveries.webhook_id, webhookId))
      .orderBy(desc(outboundWebhookDeliveries.created_at))
      .limit(limit)
      .all();
    return rows.map(rowToDelivery);
  }

  async schedule(entry: {
    webhookId: string;
    event: string;
    payload: string;
    webhookUrl: string;
    webhookSecret: string;
    nextAttemptAt: string;
  }): Promise<string> {
    const id = generateId();
    await this.db
      .insert(outboundWebhookDeliveries)
      .values({
        id,
        webhook_id: entry.webhookId,
        event: entry.event,
        status_code: null,
        attempt: 0,
        succeeded: 0,
        error: null,
        created_at: new Date().toISOString(),
        next_attempt_at: entry.nextAttemptAt,
        payload: entry.payload,
        webhook_url: entry.webhookUrl,
        webhook_secret: entry.webhookSecret,
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
      event: string;
      payload: string | null;
      webhook_url: string | null;
      webhook_secret: string | null;
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
          RETURNING id, webhook_id, event, payload, webhook_url, webhook_secret, attempt, max_attempts
        `,
    );
    return rows.map((r) => ({
      id: r.id,
      webhook_id: r.webhook_id,
      event: r.event,
      payload: r.payload ?? "",
      webhook_url: r.webhook_url ?? "",
      webhook_secret: r.webhook_secret ?? "",
      attempt: r.attempt,
      max_attempts: r.max_attempts,
    }));
  }

  /** See PG store for rationale. SQLite is single-process so the CAS
   *  serializes trivially at the statement level. */
  async claimById(
    id: string,
    claimExpiry: string,
    now: string,
  ): Promise<PendingWebhookDelivery | null> {
    const rows = await this.db.all<{
      id: string;
      webhook_id: string;
      event: string;
      payload: string | null;
      webhook_url: string | null;
      webhook_secret: string | null;
      attempt: number;
      max_attempts: number;
    }>(
      sql`
          UPDATE outbound_webhook_deliveries
          SET next_attempt_at = ${claimExpiry}
          WHERE id = ${id}
            AND status = 'pending'
            AND next_attempt_at <= ${now}
          RETURNING id, webhook_id, event, payload, webhook_url, webhook_secret, attempt, max_attempts
        `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      webhook_id: row.webhook_id,
      event: row.event,
      payload: row.payload ?? "",
      webhook_url: row.webhook_url ?? "",
      webhook_secret: row.webhook_secret ?? "",
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
      })
      .where(eq(outboundWebhookDeliveries.id, id))
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
      })
      .where(eq(outboundWebhookDeliveries.id, id))
      .run();
  }

  async markDeadLetter(id: string): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({ status: "dead_letter" })
      .where(eq(outboundWebhookDeliveries.id, id))
      .run();
  }
}
