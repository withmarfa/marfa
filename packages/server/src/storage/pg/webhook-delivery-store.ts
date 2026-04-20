import { eq, desc, sql } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { WebhookDelivery } from "@mymehq/shared";
import type {
  PendingWebhookDelivery,
  WebhookDeliveryStore,
} from "../interface.js";
import { webhookDeliveries } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Claim window — how long a polled row is hidden from other pollers.
 * Tuned to be longer than the 10s HTTP attempt timeout so a single
 * instance finishes delivery and writes markSuccess/markFailed before the
 * row becomes visible again, but short enough that a crashed instance
 * doesn't keep a delivery stalled.
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
      status: "pending",
    });
    return id;
  }

  /**
   * Atomic claim of pending deliveries. Two Myme instances pointed at the
   * same database can both poll; without a claim each would see the same
   * `status='pending'` rows and double-deliver. This statement wraps the
   * eligibility SELECT in `FOR UPDATE SKIP LOCKED` and, in one trip,
   * pushes each claimed row's `next_attempt_at` forward by
   * CLAIM_LOCK_TTL_MS so it falls out of the "eligible" window for the
   * duration of the HTTP attempt. If the process crashes before
   * success/retry is written, the row naturally becomes claimable again
   * after the TTL — no janitor needed.
   */
  async getPending(now: string, limit = 50): Promise<PendingWebhookDelivery[]> {
    const claimExpiry = new Date(Date.now() + CLAIM_LOCK_TTL_MS).toISOString();
    const result = await this.db.execute(sql`
      UPDATE webhook_deliveries
      SET next_attempt_at = ${claimExpiry}
      WHERE id IN (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, webhook_id, event, payload, webhook_url, webhook_secret, attempt, max_attempts
    `);
    const rows = result as unknown as {
      id: string;
      webhook_id: string;
      event: string;
      payload: string | null;
      webhook_url: string | null;
      webhook_secret: string | null;
      attempt: number;
      max_attempts: number;
    }[];
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

  /**
   * Single-row atomic claim used by the direct-dispatch fast path. The
   * `WHERE id = ? AND status = 'pending' AND next_attempt_at <= now` guard
   * acts as a CAS: if the poller has already claimed the row (its
   * `next_attempt_at` is in the future) or the row was successfully
   * delivered (`status = 'success'`), zero rows match and `null` comes
   * back. On a successful claim, `next_attempt_at` is pushed to the claim
   * expiry so the poller's next tick doesn't re-pick the same row.
   * Postgres row-level locking serialises concurrent UPDATEs to the same
   * id — no explicit `FOR UPDATE` transaction needed.
   */
  async claimById(
    id: string,
    claimExpiry: string,
    now: string,
  ): Promise<PendingWebhookDelivery | null> {
    const result = await this.db.execute(sql`
      UPDATE webhook_deliveries
      SET next_attempt_at = ${claimExpiry}
      WHERE id = ${id}
        AND status = 'pending'
        AND next_attempt_at <= ${now}
      RETURNING id, webhook_id, event, payload, webhook_url, webhook_secret, attempt, max_attempts
    `);
    const rows = result as unknown as {
      id: string;
      webhook_id: string;
      event: string;
      payload: string | null;
      webhook_url: string | null;
      webhook_secret: string | null;
      attempt: number;
      max_attempts: number;
    }[];
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
      .update(webhookDeliveries)
      .set({
        status: "success",
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
        status: nextAttemptAt === null ? "dead_letter" : "pending",
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async markDeadLetter(id: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: "dead_letter" })
      .where(eq(webhookDeliveries.id, id));
  }
}
