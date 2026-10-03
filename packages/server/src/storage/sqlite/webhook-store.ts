import { randomBytes } from "node:crypto";
import { eq, gt, sql } from "drizzle-orm";
import {
  generateId,
  isValidId,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { CreateWebhookInput, UpdateWebhookInput } from "@withmarfa/shared";
import { safeJsonParse } from "../json-utils.js";
import type {
  EventLogStore,
  StoredWebhook,
  WebhookOwner,
  WebhookCheckpoint,
  WebhookStore,
} from "../interface.js";
import {
  outboundWebhooks,
  outboundWebhookCheckpoint,
  outboundWebhookDeliveries,
} from "./schema.js";
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

function eventId(value: string): bigint {
  if (
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  ) {
    throw new Error("Invalid outbound webhook event checkpoint");
  }
  return BigInt(value);
}

function rowToWebhook(
  row: typeof outboundWebhooks.$inferSelect,
): StoredWebhook {
  return {
    id: row.id,
    event_start_id: eventId(row.event_start_id),
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
  constructor(
    private db: DrizzleDb,
    private events: EventLogStore,
  ) {}

  /** Called in the storage factory's writer transaction, before writes are accepted. */
  async initialize(): Promise<void> {
    if (await this.db.select().from(outboundWebhookCheckpoint).get()) return;
    if (
      (await this.events.getMaxId()) !== null ||
      (await this.count()) !== 0 ||
      (await this.db
        .select({ id: outboundWebhookDeliveries.id })
        .from(outboundWebhookDeliveries)
        .limit(1)
        .get())
    )
      return;
    await this.db
      .insert(outboundWebhookCheckpoint)
      .values({ id: 1, last_event_id: "0" })
      .run();
  }

  async checkpoint(): Promise<WebhookCheckpoint> {
    const row = await this.db.select().from(outboundWebhookCheckpoint).get();
    if (!row)
      throw new Error(
        "Outbound webhook checkpoint is missing on a populated instance",
      );
    const lastEventId = eventId(row.last_event_id);
    const inProgress = row.event_id === null ? null : eventId(row.event_id);
    if (
      (inProgress === null && row.after_subscription_id !== null) ||
      (inProgress !== null && inProgress !== lastEventId + 1n) ||
      (row.after_subscription_id !== null &&
        !isValidId(row.after_subscription_id))
    ) {
      throw new Error("Outbound webhook checkpoint is inconsistent");
    }
    return {
      lastEventId,
      eventId: inProgress,
      afterSubscriptionId: row.after_subscription_id,
    };
  }

  async acknowledge(position: WebhookCheckpoint): Promise<void> {
    await this.db
      .update(outboundWebhookCheckpoint)
      .set({
        last_event_id: position.lastEventId.toString(),
        event_id: position.eventId?.toString() ?? null,
        after_subscription_id: position.afterSubscriptionId,
      })
      .where(eq(outboundWebhookCheckpoint.id, 1))
      .run();
  }

  async listAfter(
    afterId: string | null,
    limit: number,
  ): Promise<StoredWebhook[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhooks)
      .where(afterId === null ? undefined : gt(outboundWebhooks.id, afterId))
      .orderBy(outboundWebhooks.id)
      .limit(limit)
      .all();
    return rows.map(rowToWebhook);
  }

  async create(
    input: CreateWebhookInput & { owner: WebhookOwner },
  ): Promise<StoredWebhook> {
    return this.db.transaction(async () => {
      await this.checkpoint();
      const now = new Date().toISOString();
      const row = {
        event_start_id: ((await this.events.getMaxId()) ?? 0n).toString(),
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
    });
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

  async count(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(outboundWebhooks)
      .get();
    return row?.count ?? 0;
  }
}
