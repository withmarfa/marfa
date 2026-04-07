import { eq, desc, and, lte, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { WebhookDelivery } from "@mymehq/shared";
import type { WebhookDeliveryStore } from "../interface.js";
import { webhookDeliveries } from "./schema.js";
import type { PgDb } from "./connection.js";

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

export class PgWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private db: PgDb) {}

  async log(entry: {
    webhookId: string;
    event: string;
    statusCode?: number;
    attempt: number;
    success: boolean;
    error?: string;
  }): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: generateId(),
      webhook_id: entry.webhookId,
      event: entry.event,
      status_code: entry.statusCode ?? null,
      attempt: entry.attempt,
      success: entry.success ? 1 : 0,
      error: entry.error ?? null,
      created_at: new Date().toISOString(),
    });
  }

  async list(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhook_id, webhookId))
      .orderBy(desc(webhookDeliveries.created_at))
      .limit(limit);
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
    await this.db.insert(webhookDeliveries).values({
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
      status: 'pending',
    });
    return id;
  }

  async getPending(
    now: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      webhook_id: string;
      event: string;
      payload: string;
      webhook_url: string;
      webhook_secret: string;
      attempt: number;
      max_attempts: number;
    }>
  > {
    const rows = await this.db
      .select({
        id: webhookDeliveries.id,
        webhook_id: webhookDeliveries.webhook_id,
        event: webhookDeliveries.event,
        payload: webhookDeliveries.payload,
        webhook_url: webhookDeliveries.webhook_url,
        webhook_secret: webhookDeliveries.webhook_secret,
        attempt: webhookDeliveries.attempt,
        max_attempts: webhookDeliveries.max_attempts,
      })
      .from(webhookDeliveries)
      .where(
        and(
          sql`${webhookDeliveries.status} = 'pending'`,
          lte(webhookDeliveries.next_attempt_at, now),
        ),
      )
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      webhook_id: r.webhook_id,
      event: r.event,
      payload: r.payload ?? '',
      webhook_url: r.webhook_url ?? '',
      webhook_secret: r.webhook_secret ?? '',
      attempt: r.attempt,
      max_attempts: r.max_attempts,
    }));
  }

  async markSuccess(
    id: string,
    statusCode: number,
    attempt: number,
  ): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: 'success',
        success: 1,
        status_code: statusCode,
        attempt,
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async markFailed(
    id: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status_code: statusCode ?? null,
        error,
        attempt,
        next_attempt_at: nextAttemptAt,
        status: nextAttemptAt === null ? 'dead_letter' : 'pending',
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async markDeadLetter(id: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'dead_letter' })
      .where(eq(webhookDeliveries.id, id));
  }
}
