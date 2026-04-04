import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { generateId, MymeError, ErrorCode } from "@mymehq/shared";
import type {
  Webhook,
  CreateWebhookInput,
  UpdateWebhookInput,
} from "@mymehq/shared";
import { safeJsonParse } from "../json-utils.js";
import type { WebhookStore } from "../interface.js";
import { webhooks } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

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

export class SqliteWebhookStore implements WebhookStore {
  constructor(private db: DrizzleDb) {}

  create(input: CreateWebhookInput, tenantId?: string): Promise<Webhook> {
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
    this.db.insert(webhooks).values(row).run();
    return Promise.resolve(rowToWebhook(row));
  }

  list(tenantId?: string): Promise<Webhook[]> {
    const rows =
      tenantId !== undefined
        ? this.db
            .select()
            .from(webhooks)
            .where(eq(webhooks.tenant_id, tenantId))
            .all()
        : this.db.select().from(webhooks).all();
    return Promise.resolve(rows.map(rowToWebhook));
  }

  get(id: string, tenantId?: string): Promise<Webhook | null> {
    const conditions = [eq(webhooks.id, id)];
    if (tenantId !== undefined) {
      conditions.push(eq(webhooks.tenant_id, tenantId));
    }
    const row = this.db
      .select()
      .from(webhooks)
      .where(and(...conditions))
      .get();
    return Promise.resolve(row ? rowToWebhook(row) : null);
  }

  update(id: string, input: UpdateWebhookInput): Promise<Webhook> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (input.url !== undefined) updates.url = input.url;
    if (input.events !== undefined)
      updates.events = JSON.stringify(input.events);
    if (input.type_filter !== undefined)
      updates.type_filter = input.type_filter ?? null;
    if (input.active !== undefined) updates.active = input.active ? 1 : 0;

    this.db.update(webhooks).set(updates).where(eq(webhooks.id, id)).run();

    const row = this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, id))
      .get();
    if (!row) {
      throw new MymeError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return Promise.resolve(rowToWebhook(row));
  }

  delete(id: string): Promise<void> {
    this.db.delete(webhooks).where(eq(webhooks.id, id)).run();
    return Promise.resolve();
  }

  listActive(): Promise<Webhook[]> {
    const rows = this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.active, 1))
      .all();
    return Promise.resolve(rows.map(rowToWebhook));
  }
}
