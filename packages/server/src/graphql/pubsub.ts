import { EventEmitter, on } from "node:events";
import type { Item, Metadata } from "@mymehq/shared";

export interface ItemEvent {
  type: "created" | "updated" | "deleted" | "restored" | "transitioned";
  item: Item;
  metadata?: Metadata;
  tenantId?: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(Number(process.env.MAX_SUBSCRIPTION_LISTENERS) || 100);

export function publish(event: ItemEvent): void {
  emitter.emit("ITEM_CHANGED", event);
}

export interface SubscribeOptions {
  typeFilter?: string;
  tenantId?: string;
}

export async function* subscribe(
  options?: SubscribeOptions,
): AsyncGenerator<ItemEvent> {
  const iter = on(emitter, "ITEM_CHANGED");
  for await (const [event] of iter) {
    const itemEvent = event as ItemEvent;
    if (options?.typeFilter && itemEvent.item.type !== options.typeFilter)
      continue;
    if (options?.tenantId && itemEvent.tenantId !== options.tenantId) continue;
    yield itemEvent;
  }
}
