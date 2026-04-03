import { EventEmitter, on } from "node:events";
import type { Item, Metadata } from "@myme/shared";

export interface ItemEvent {
  type: "created" | "updated" | "deleted" | "restored" | "transitioned";
  item: Item;
  metadata?: Metadata;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(Number(process.env.MAX_SUBSCRIPTION_LISTENERS) || 100);

export function publish(event: ItemEvent): void {
  emitter.emit("ITEM_CHANGED", event);
}

export async function* subscribe(
  typeFilter?: string,
): AsyncGenerator<ItemEvent> {
  const iter = on(emitter, "ITEM_CHANGED");
  for await (const [event] of iter) {
    const itemEvent = event as ItemEvent;
    if (typeFilter && itemEvent.item.type !== typeFilter) continue;
    yield itemEvent;
  }
}
