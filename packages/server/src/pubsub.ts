import { EventEmitter, on } from "node:events";
import type { Item, Metadata } from "@mymehq/shared";
import type { EventLogStore } from "./storage/interface.js";

export interface ItemEvent {
  type:
    | "created"
    | "updated"
    | "deleted"
    | "restored"
    | "state_changed"
    | "metadata_changed";
  item: Item;
  metadata?: Metadata;
  tenantId?: string;
}

export interface ItemEventWithId extends ItemEvent {
  eventId?: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(Number(process.env.MAX_SUBSCRIPTION_LISTENERS) || 100);

let eventLogStore: EventLogStore | null = null;

/** Call once at startup to enable event persistence. */
export function initEventLog(store: EventLogStore): void {
  eventLogStore = store;
}

/**
 * Maps an internal ItemEvent.type to its V0-spec wire string. Most event
 * types are namespaced as `item.<type>`; metadata_changed is the
 * exception per V0 spec — it surfaces as the bare `metadata.changed`
 * because it describes a metadata-layer change rather than an item-level
 * mutation. Mirrored by routes/events.ts so SSE wire and webhook
 * payloads agree.
 */
function wireEventName(type: ItemEvent["type"]): string {
  return type === "metadata_changed" ? "metadata.changed" : `item.${type}`;
}

export async function publish(event: ItemEvent): Promise<number | undefined> {
  let eventId: number | undefined;

  if (eventLogStore) {
    const payload = JSON.stringify({
      type: wireEventName(event.type),
      item: event.item,
      ...(event.metadata && { metadata: event.metadata }),
    });
    eventId = await eventLogStore.append({
      event_type: event.type,
      item_id: event.item.id,
      tenant_id: event.tenantId,
      payload,
    });
  }

  emitter.emit("ITEM_CHANGED", { ...event, eventId } as ItemEventWithId);
  return eventId;
}

export interface SubscribeOptions {
  typeFilter?: string;
  tenantId?: string;
}

export async function* subscribe(
  options?: SubscribeOptions,
): AsyncGenerator<ItemEventWithId> {
  const iter = on(emitter, "ITEM_CHANGED");
  for await (const [event] of iter) {
    const itemEvent = event as ItemEventWithId;
    if (options?.typeFilter && itemEvent.item.type !== options.typeFilter)
      continue;
    if (options?.tenantId && itemEvent.tenantId !== options.tenantId) continue;
    yield itemEvent;
  }
}
