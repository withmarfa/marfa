import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@mymehq/shared";
import { envNumber } from "./config.js";
import type { EventLogStore, Storage } from "./storage/interface.js";

/**
 * Cycle-detection metadata carried on every published event (workstream
 * 2 PR 8). When a connector reaction publishes a downstream event, the
 * caller threads this through unchanged from the parent — that's how we
 * detect runaway loops where connector A reacts to event X by publishing
 * Y, connector B reacts to Y by publishing Z, and so on.
 *
 *   - `originatingConnectionId` is set when the chain was kicked off by
 *     a connector (not a human). It propagates verbatim down the chain.
 *   - `hopCount` increments on each reactive publish; pubsub.publish()
 *     drops events whose hop_count would exceed the tenant's
 *     `max_event_hop_budget` (default 5).
 *
 * Events originating from a human caller MUST omit both fields (or pass
 * `hopCount: 0` and `originatingConnectionId: null`).
 */
export interface CycleMetadata {
  originatingConnectionId?: string | null;
  hopCount?: number;
}

export interface ItemEvent extends CycleMetadata {
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

export interface EdgeEvent extends CycleMetadata {
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
emitter.setMaxListeners(envNumber(process.env.MAX_SUBSCRIPTION_LISTENERS, 100));

/** Default hop budget when the tenant has no override configured. */
export const DEFAULT_HOP_BUDGET = 5;

let eventLogStore: EventLogStore | null = null;
let getHopBudget: (tenantId: string | undefined) => Promise<number> = () =>
  Promise.resolve(DEFAULT_HOP_BUDGET);
let onHopOverflow:
  | ((event: PubsubEvent, budget: number) => Promise<void>)
  | null = null;

export interface InitEventLogOptions {
  /**
   * Resolve the per-tenant hop budget. Defaults to `DEFAULT_HOP_BUDGET`.
   * Hosted-mode wiring reads `tenants.getConfig(...).max_event_hop_budget`.
   */
  getHopBudget?: (tenantId: string | undefined) => Promise<number>;
  /**
   * Hook fired when an event is dropped due to hop overflow. The default
   * (when unset) is a no-op; the server's bootstrap installs a hook that
   * writes a `system.activity` row with severity `error` so the user
   * surface can show the loop detection.
   */
  onHopOverflow?: (event: PubsubEvent, budget: number) => Promise<void>;
}

/** Call once at startup to enable event persistence + cycle detection. */
export function initEventLog(
  store: EventLogStore,
  options?: InitEventLogOptions,
): void {
  eventLogStore = store;
  if (options?.getHopBudget) getHopBudget = options.getHopBudget;
  if (options?.onHopOverflow) onHopOverflow = options.onHopOverflow;
}

/**
 * Reset the cycle-detection wiring (test-only). Restores the default
 * hop-budget callback and clears the overflow hook.
 */
export function __resetCycleDetectionForTests(): void {
  getHopBudget = () => Promise.resolve(DEFAULT_HOP_BUDGET);
  onHopOverflow = null;
}

/**
 * Helper for connector reaction handlers (workstream 3 wires this in;
 * exported here so the contract is in one place). Returns the cycle
 * metadata to stamp on a downstream event when reacting to a parent —
 * propagates `originatingConnectionId` (taking the parent's, or stamping
 * the current connector's if the chain starts here) and increments
 * `hopCount`.
 */
export function nextHopMetadata(
  parent: CycleMetadata,
  currentConnectionId?: string,
): Required<CycleMetadata> {
  const hopCount = (parent.hopCount ?? 0) + 1;
  const originatingConnectionId =
    parent.originatingConnectionId ?? currentConnectionId ?? null;
  return { originatingConnectionId, hopCount };
}

/**
 * Build the InitEventLogOptions wiring from a Storage instance. The
 * server's bootstrap calls this; tests can opt in or pass their own
 * stubs.
 */
export function defaultCycleDetectionWiring(
  storage: Storage,
): InitEventLogOptions {
  return {
    getHopBudget: async (tenantId) => {
      if (!tenantId || !storage.tenants) return DEFAULT_HOP_BUDGET;
      const cfg = await storage.tenants.getConfig(tenantId);
      return cfg?.max_event_hop_budget ?? DEFAULT_HOP_BUDGET;
    },
    onHopOverflow: async (event, budget) => {
      // Emit a `system.activity` row directly via storage.items.create —
      // bypassing pubsub.publish so the activity isn't itself fed back
      // into the bus and re-counted toward the budget.
      const tenantId = event.tenantId;
      const originatingConnectionId =
        event.originatingConnectionId ??
        ("item" in event ? event.item.id : event.edge.id);
      try {
        await storage.items.create(
          {
            type: "system.activity",
            properties: {
              severity: "error",
              summary: `Event hop budget (${String(budget)}) exceeded; further reactions dropped`,
              connection_id: originatingConnectionId,
              detail: {
                event_type: event.type,
                hop_count: event.hopCount,
                budget,
              },
            },
          },
          tenantId,
        );
      } catch {
        // Best-effort — failure to record the overflow doesn't crash the
        // whole publish path. The dropped-event signal lives in audit.log
        // on the storage side.
      }
    },
  };
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

/**
 * Check whether the event would exceed the tenant's hop budget. When it
 * does, fire the overflow hook and return false so the caller skips
 * persistence + emission. Returns true on the happy path.
 */
async function passesHopBudget(event: PubsubEvent): Promise<boolean> {
  const hopCount = event.hopCount ?? 0;
  if (hopCount === 0) return true;
  const budget = await getHopBudget(event.tenantId);
  if (hopCount <= budget) return true;
  if (onHopOverflow) {
    try {
      await onHopOverflow(event, budget);
    } catch {
      // Swallow — overflow handler errors don't propagate.
    }
  }
  return false;
}

export async function publish(event: ItemEvent): Promise<number | undefined> {
  if (!(await passesHopBudget(event))) return undefined;

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
      originating_connection_id: event.originatingConnectionId ?? null,
      hop_count: event.hopCount ?? 0,
    });
  }

  emitter.emit("ITEM_CHANGED", { ...event, eventId } as ItemEventWithId);
  return eventId;
}

/**
 * Publish an edge lifecycle event. Persists via event_log with
 * item_id = null and edge_id = edge.id. Subscribers filter by edge_id
 * (or accept all edge events); the `?type=` SSE filter applies to
 * item events only since edges carry no content type.
 */
export async function publishEdge(
  event: EdgeEvent,
): Promise<number | undefined> {
  if (!(await passesHopBudget(event))) return undefined;

  let eventId: number | undefined;

  if (eventLogStore) {
    const payload = JSON.stringify({
      type: wireEventName(event.type),
      edge: event.edge,
    });
    eventId = await eventLogStore.append({
      event_type: event.type,
      item_id: null,
      edge_id: event.edge.id,
      tenant_id: event.tenantId,
      payload,
      originating_connection_id: event.originatingConnectionId ?? null,
      hop_count: event.hopCount ?? 0,
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
export async function* subscribeEdges(options?: {
  tenantId?: string;
}): AsyncGenerator<EdgeEventWithId> {
  const iter = on(emitter, "EDGE_CHANGED");
  for await (const [event] of iter) {
    const edgeEvent = event as EdgeEventWithId;
    if (options?.tenantId && edgeEvent.tenantId !== options.tenantId) continue;
    yield edgeEvent;
  }
}

// Keep isEdgeEvent exported-private to consumers that type-narrow on the union.
export { isEdgeEvent };
