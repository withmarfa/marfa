import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@mymehq/shared";
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

export interface EdgeEvent {
  type: "edge_created" | "edge_deleted";
  edge: Edge;
  tenantId?: string;
}

export type PubsubEvent = ItemEvent | EdgeEvent;

export interface ItemEventWithId extends ItemEvent {
  eventId?: number;
}

export interface EdgeEventWithId extends EdgeEvent {
  eventId?: number;
}

export type PubsubEventWithId = ItemEventWithId | EdgeEventWithId;

const emitter = new EventEmitter();
emitter.setMaxListeners(Number(process.env.MAX_SUBSCRIPTION_LISTENERS) || 100);

let eventLogStore: EventLogStore | null = null;

/** Call once at startup to enable event persistence. */
export function initEventLog(store: EventLogStore): void {
  eventLogStore = store;
}

/**
 * Maps an internal event type to its V0-spec wire string.
 *   item.* for item events (created / updated / deleted / restored /
 *     state_changed)
 *   metadata.changed (bare, not namespaced) for metadata mutations —
 *     V0 spec exception because it describes a metadata-layer change
 *   edge.created / edge.deleted for edge lifecycle events
 *
 * Mirrored by routes/events.ts, webhooks/delivery.ts, and
 * routes/webhooks.ts so SSE wire, webhook payloads, and subscription
 * validation all agree.
 */
export function wireEventName(type: PubsubEvent["type"]): string {
  if (type === "metadata_changed") return "metadata.changed";
  if (type === "edge_created") return "edge.created";
  if (type === "edge_deleted") return "edge.deleted";
  return `item.${type}`;
}

function isEdgeEvent(event: PubsubEvent): event is EdgeEvent {
  return "edge" in event;
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

/**
 * Publish an edge lifecycle event. Persists via event_log with
 * item_id = edge.source_id and edge_id = edge.id so replay flows through
 * the same filtering machinery as item events.
 */
export async function publishEdge(event: EdgeEvent): Promise<number | undefined> {
  let eventId: number | undefined;

  if (eventLogStore) {
    const payload = JSON.stringify({
      type: wireEventName(event.type),
      edge: event.edge,
    });
    eventId = await eventLogStore.append({
      event_type: event.type,
      item_id: event.edge.source_id,
      edge_id: event.edge.id,
      tenant_id: event.tenantId,
      payload,
    });
  }

  emitter.emit("EDGE_CHANGED", { ...event, eventId } as EdgeEventWithId);
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

/** Subscribe to edge lifecycle events. Filters by tenant only; there is
 *  no typeFilter since edges don't carry a content type. */
export async function* subscribeEdges(
  options?: { tenantId?: string },
): AsyncGenerator<EdgeEventWithId> {
  const iter = on(emitter, "EDGE_CHANGED");
  for await (const [event] of iter) {
    const edgeEvent = event as EdgeEventWithId;
    if (options?.tenantId && edgeEvent.tenantId !== options.tenantId) continue;
    yield edgeEvent;
  }
}

// Keep isEdgeEvent exported-private to consumers that type-narrow on the union.
export { isEdgeEvent };
