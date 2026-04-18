import { eq, desc, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { WebhookDelivery } from "@mymehq/shared";
import type { WebhookDeliveryStore } from "../interface.js";
import { webhookDeliveries } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/**
 * See the PG store for rationale. SQLite deployments are single-process so
 * the race this guards against cannot occur here, but the claim-forward
 * semantics are preserved so the two backends stay behaviourally identical.
 */
const CLAIM_LOCK_TTL_MS = 60_000;

function rowToDelivery(
  row: typeof webhookDeliveries.$inferSelect,
): WebhookDelivery {
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    event: row.event,
    status_code: row.status_code ?? null,
    attempt: row.attempt,
    success: row.success === 1,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: DrizzleDb) {}

  log(entry: {
    webhookId: string;
    event: string;
    statusCode?: number;
    attempt: number;
    success: boolean;
    error?: string;
  }): Promise<void> {
    this.db
      .insert(webhookDeliveries)
      .values({
        id: generateId(),
        webhook_id: entry.webhookId,
        event: entry.event,
        status_code: entry.statusCode ?? null,
        attempt: entry.attempt,
        success: entry.success ? 1 : 0,
        error: entry.error ?? null,
        created_at: new Date().toISOString(),
      })
      .run();
    return Promise.resolve();
  }

  list(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const rows = this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhook_id, webhookId))
      .orderBy(desc(webhookDeliveries.created_at))
      .limit(limit)
      .all();
    return Promise.resolve(rows.map(rowToDelivery));
  }

  schedule(entry: {
    webhookId: string;
    event: string;
    payload: string;
    webhookUrl: string;
    webhookSecret: string;
    nextAttemptAt: string;
  }): Promise<string> {
    const id = generateId();
    this.db
      .insert(webhookDeliveries)
      .values({
        id,
        webhook_id: entry.webhookId,
        event: entry.event,
        status_code: null,
        attempt: 0,
        success: 0,
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
    return Promise.resolve(id);
  }

  getPending(
    now: string,
    limit = 50,
  ): Promise<
    {
      id: string;
      webhook_id: string;
      event: string;
      payload: string;
      webhook_url: string;
      webhook_secret: string;
      attempt: number;
      max_attempts: number;
    }[]
  > {
    const claimExpiry = new Date(Date.now() + CLAIM_LOCK_TTL_MS).toISOString();
    const rows = this.db.all<{
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
          UPDATE webhook_deliveries
          SET next_attempt_at = ${claimExpiry}
          WHERE id IN (
            SELECT id FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at
            LIMIT ${limit}
          )
          RETURNING id, webhook_id, event, payload, webhook_url, webhook_secret, attempt, max_attempts
        `,
    );
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        webhook_id: r.webhook_id,
        event: r.event,
        payload: r.payload ?? "",
        webhook_url: r.webhook_url ?? "",
        webhook_secret: r.webhook_secret ?? "",
        attempt: r.attempt,
        max_attempts: r.max_attempts,
      })),
    );
  }

  markSuccess(id: string, statusCode: number, attempt: number): Promise<void> {
    this.db
      .update(webhookDeliveries)
      .set({
        status: "success",
        success: 1,
        status_code: statusCode,
        attempt,
      })
      .where(eq(webhookDeliveries.id, id))
      .run();
    return Promise.resolve();
  }

  markFailed(
    id: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<void> {
    this.db
      .update(webhookDeliveries)
      .set({
        status_code: statusCode ?? null,
        error,
        attempt,
        next_attempt_at: nextAttemptAt,
        status: nextAttemptAt === null ? "dead_letter" : "pending",
      })
      .where(eq(webhookDeliveries.id, id))
      .run();
    return Promise.resolve();
  }

  markDeadLetter(id: string): Promise<void> {
    this.db
      .update(webhookDeliveries)
      .set({ status: "dead_letter" })
      .where(eq(webhookDeliveries.id, id))
      .run();
    return Promise.resolve();
  }
}
