import { randomBytes } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { generateId, MymeError, ErrorCode } from "@mymehq/shared";
import type {
  Webhook,
  CreateWebhookInput,
  UpdateWebhookInput,
} from "@mymehq/shared";
import { safeJsonParse } from "../json-utils.js";
import type { WebhookStore } from "../interface.js";
import { webhooks } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToWebhook(row: typeof webhooks.$inferSelect): Webhook {
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? undefined,
    url: row.url,
    secret: row.secret,
    events: safeJsonParse<string[]>(row.events, [], "webhook events"),
    type_filter: row.type_filter ?? undefined,
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PgWebhookStore implements WebhookStore {
  constructor(private db: PgDb) {}

  async create(input: CreateWebhookInput, tenantId?: string): Promise<Webhook> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      tenant_id: tenantId ?? null,
      url: input.url,
      secret: input.secret ?? randomBytes(32).toString("hex"),
      events: JSON.stringify(input.events),
      type_filter: input.type_filter ?? null,
      active: 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(webhooks).values(row);
    return rowToWebhook(row);
  }

  async list(tenantId?: string): Promise<Webhook[]> {
    const rows =
      tenantId !== undefined
        ? await this.db
            .select()
            .from(webhooks)
            .where(eq(webhooks.tenant_id, tenantId))
        : await this.db.select().from(webhooks);
    return rows.map(rowToWebhook);
  }

  async get(id: string, tenantId?: string): Promise<Webhook | null> {
    const conditions = [eq(webhooks.id, id)];
    if (tenantId !== undefined) {
      conditions.push(eq(webhooks.tenant_id, tenantId));
    }
    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(and(...conditions));
    return row ? rowToWebhook(row) : null;
  }

  async update(id: string, input: UpdateWebhookInput): Promise<Webhook> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (input.url !== undefined) updates.url = input.url;
    if (input.events !== undefined)
      updates.events = JSON.stringify(input.events);
    if (input.type_filter !== undefined)
      updates.type_filter = input.type_filter ?? null;
    if (input.active !== undefined) updates.active = input.active ? 1 : 0;

    await this.db.update(webhooks).set(updates).where(eq(webhooks.id, id));

    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, id));
    if (!row) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return rowToWebhook(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(webhooks).where(eq(webhooks.id, id));
  }

  async listActive(): Promise<Webhook[]> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.active, 1));
    return rows.map(rowToWebhook);
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(webhooks);
    return Number(row?.count ?? 0);
  }
}
