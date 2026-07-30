import { randomBytes } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { generateId, MarfaError, ErrorCode } from "@withmarfa/shared";
import type {
  Webhook,
  CreateWebhookInput,
  UpdateWebhookInput,
} from "@withmarfa/shared";
import { safeJsonParse } from "../json-utils.js";
import type { WebhookStore } from "../interface.js";
import { outboundWebhooks } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToWebhook(row: typeof outboundWebhooks.$inferSelect): Webhook {
  return {
    id: row.id,
    space_id: row.space_id ?? undefined,
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

  async create(input: CreateWebhookInput, spaceId?: string): Promise<Webhook> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      space_id: spaceId ?? null,
      url: input.url,
      secret: input.secret ?? randomBytes(32).toString("hex"),
      events: JSON.stringify(input.events),
      type_filter: input.type_filter ?? null,
      active: 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(outboundWebhooks).values(row);
    return rowToWebhook(row);
  }

  async list(spaceId?: string): Promise<Webhook[]> {
    const rows =
      spaceId !== undefined
        ? await this.db
            .select()
            .from(outboundWebhooks)
            .where(eq(outboundWebhooks.space_id, spaceId))
        : await this.db.select().from(outboundWebhooks);
    return rows.map(rowToWebhook);
  }

  async get(id: string, spaceId?: string): Promise<Webhook | null> {
    const conditions = [eq(outboundWebhooks.id, id)];
    if (spaceId !== undefined) {
      conditions.push(eq(outboundWebhooks.space_id, spaceId));
    }
    const [row] = await this.db
      .select()
      .from(outboundWebhooks)
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

    await this.db
      .update(outboundWebhooks)
      .set(updates)
      .where(eq(outboundWebhooks.id, id));

    const [row] = await this.db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.id, id));
    if (!row) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return rowToWebhook(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(outboundWebhooks).where(eq(outboundWebhooks.id, id));
  }

  async listActive(): Promise<Webhook[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.active, 1));
    return rows.map(rowToWebhook);
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundWebhooks);
    return row?.count ?? 0;
  }
}
