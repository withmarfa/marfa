import type { Context } from "hono";
import type { WebhookDelivery, PaginatedResult } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage, WebhookOwner } from "../storage/interface.js";
import {
  listReadableWebhooks,
  readWebhookDeliveries,
} from "../webhooks/read.js";

export interface WebhookHistory {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  history: PaginatedResult<WebhookDelivery> | null;
}
export async function webhookHistories(
  storage: Storage,
  c: Context<AppEnv>,
  maker: WebhookOwner,
): Promise<WebhookHistory[] | null> {
  try {
    const hooks = (await listReadableWebhooks(storage, c)).filter(
      (w) =>
        w.owner.kind === maker.kind &&
        (w.owner.kind === "key" && maker.kind === "key"
          ? w.owner.keyId === maker.keyId
          : w.owner.kind === "grant" &&
            maker.kind === "grant" &&
            w.owner.clientId === maker.clientId &&
            w.owner.authUserId === maker.authUserId),
    );
    return await Promise.all(
      hooks.map(async (w) => ({
        id: w.id,
        url: w.url,
        events: w.events,
        active: w.active,
        history: await readWebhookDeliveries(storage, c, w.id, {
          limit: 10,
        }).catch(() => null),
      })),
    );
  } catch {
    return null;
  }
}
