import { eq, desc } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { WebhookDelivery } from "@myme/shared";
import type { WebhookDeliveryStore } from "../interface.js";
import { webhookDeliveries } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

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
}
