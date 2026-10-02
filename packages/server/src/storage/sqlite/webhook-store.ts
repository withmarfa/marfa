import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { generateId, MarfaError, ErrorCode } from "@withmarfa/shared";
import type { CreateWebhookInput, UpdateWebhookInput } from "@withmarfa/shared";
import { safeJsonParse } from "../json-utils.js";
import type {
  StoredWebhook,
  WebhookOwner,
  WebhookStore,
} from "../interface.js";
import { outboundWebhooks } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function ownerOf(row: typeof outboundWebhooks.$inferSelect): WebhookOwner {
  if (row.key_id !== null) return { kind: "key", keyId: row.key_id };
  // The table's check holds the grant pair whole wherever no key is named.
  return {
    kind: "grant",
    clientId: row.grant_client_id ?? "",
    authUserId: row.grant_user_id ?? "",
  };
}

function rowToWebhook(
  row: typeof outboundWebhooks.$inferSelect,
): StoredWebhook {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: safeJsonParse<string[]>(row.events, [], "webhook events"),
    type_filter: row.type_filter ?? undefined,
    active: row.active === 1,
    owner: ownerOf(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteWebhookStore implements WebhookStore {
  constructor(private db: DrizzleDb) {}

  async create(
    input: CreateWebhookInput & { owner: WebhookOwner },
  ): Promise<StoredWebhook> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      url: input.url,
      secret: input.secret ?? randomBytes(32).toString("hex"),
      events: JSON.stringify(input.events),
      type_filter: input.type_filter ?? null,
      active: 1,
      key_id: input.owner.kind === "key" ? input.owner.keyId : null,
      grant_client_id:
        input.owner.kind === "grant" ? input.owner.clientId : null,
      grant_user_id:
        input.owner.kind === "grant" ? input.owner.authUserId : null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(outboundWebhooks).values(row).run();
    return rowToWebhook(row);
  }

  async list(): Promise<StoredWebhook[]> {
    const rows = await this.db.select().from(outboundWebhooks).all();
    return rows.map(rowToWebhook);
  }

  async get(id: string): Promise<StoredWebhook | null> {
    const row = await this.db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.id, id))
      .get();
    return row ? rowToWebhook(row) : null;
  }

  async update(id: string, input: UpdateWebhookInput): Promise<StoredWebhook> {
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
      .where(eq(outboundWebhooks.id, id))
      .run();

    const row = await this.db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.id, id))
      .get();
    if (!row) {
      throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
    }
    return rowToWebhook(row);
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(outboundWebhooks)
      .where(eq(outboundWebhooks.id, id))
      .run();
  }

  async listActive(): Promise<StoredWebhook[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.active, 1))
      .all();
    return rows.map(rowToWebhook);
  }

  async count(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(outboundWebhooks)
      .get();
    return row?.count ?? 0;
  }
}
