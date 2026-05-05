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
  /** event_log.id assigned by storage. `bigint` so values above
   *  Number.MAX_SAFE_INTEGER round-trip without truncation. */
  eventId?: bigint;
}

export interface EdgeEventWithId extends EdgeEvent {
  /** event_log.id assigned by storage. `bigint` — see ItemEventWithId. */
  eventId?: bigint;
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
 * TTL for the per-tenant hop-budget cache. The publish path hits this
 * lookup on every reactive (hopCount > 0) event; without caching, every
 * such publish triggers a `storage.tenants.getConfig` round-trip which
 * is a real DB hit on hosted Postgres. 30s is the trade-off: long enough
 * to absorb burst traffic at near-zero cost; short enough that an
 * operator's `PUT /tenants/current/config` change to `max_event_hop_budget`
 * propagates within a window the operator can tolerate.
 */
const HOP_BUDGET_TTL_MS = 30_000;

/**
 * Build the InitEventLogOptions wiring from a Storage instance. The
 * server's bootstrap calls this; tests can opt in or pass their own
 * stubs.
 *
 * The `getHopBudget` resolver is wrapped in a per-tenant TTL cache so
 * the publish hot path doesn't hit storage on every reactive event.
 */
export function defaultCycleDetectionWiring(
  storage: Storage,
): InitEventLogOptions {
  // Per-tenant budget cache. Sized by tenant count, expires per-entry on
  // first access past `HOP_BUDGET_TTL_MS`.
  const budgetCache = new Map<string, { value: number; expiresAt: number }>();

  const lookupBudget = async (tenantId: string): Promise<number> => {
    const now = Date.now();
    const cached = budgetCache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.value;
    if (!storage.tenants) return DEFAULT_HOP_BUDGET;
    const cfg = await storage.tenants.getConfig(tenantId);
    const value = cfg?.max_event_hop_budget ?? DEFAULT_HOP_BUDGET;
    budgetCache.set(tenantId, { value, expiresAt: now + HOP_BUDGET_TTL_MS });
    return value;
  };

  return {
    getHopBudget: async (tenantId) => {
      // No tenant scope (keys-mode self-host) → constant default; skip
      // the cache entirely.
      if (!tenantId) return DEFAULT_HOP_BUDGET;
      return lookupBudget(tenantId);
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
 * Maps an internal event type to its wire string.
 *   item.* for item events (created / updated / deleted / restored /
 *     state_changed)
 *   metadata.changed (bare, not namespaced) for metadata mutations —
 *     a deliberate exception because it describes a metadata-layer change
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
 *
 * Attribution by `originatingConnectionId !== null` (T-008) — NOT by
 * `hopCount`. A misbehaving (or hostile) connector that publishes with
 * `hopCount: 0` plus an `originatingConnectionId` set would otherwise
 * short-circuit the budget. The contract per `nextHopMetadata` is
 * `hopCount >= 1` whenever origin is set; any event that violates it
 * gets treated as `hopCount = 1` so the budget gate still applies.
 */
async function passesHopBudget(event: PubsubEvent): Promise<boolean> {
  const hopCount = event.hopCount ?? 0;
  const isConnectorOriginated = event.originatingConnectionId != null;
  // Human-originated events (no origin, no hops) bypass the budget.
  if (!isConnectorOriginated && hopCount === 0) return true;
  // Connector chains: enforce a floor of 1 so a malformed publish that
  // stamps origin but leaves hopCount at 0 doesn't slip past the budget.
  const effectiveHopCount = isConnectorOriginated
    ? Math.max(hopCount, 1)
    : hopCount;
  const budget = await getHopBudget(event.tenantId);
  if (effectiveHopCount <= budget) return true;
  if (onHopOverflow) {
    try {
      await onHopOverflow(event, budget);
    } catch {
      // Swallow — overflow handler errors don't propagate.
    }
  }
  return false;
}

export async function publish(event: ItemEvent): Promise<bigint | undefined> {
  if (!(await passesHopBudget(event))) return undefined;

  let eventId: bigint | undefined;

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
): Promise<bigint | undefined> {
  if (!(await passesHopBudget(event))) return undefined;

  let eventId: bigint | undefined;

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

/**
 * Iterator cleanup contract (§3.8).
 *
 * `subscribe()` and `subscribeEdges()` return `AsyncGenerator`s backed by
 * `events.on(emitter, ...)`. When the consumer is done — SSE client
 * disconnects, request handler completes, etc. — the consumer MUST close
 * the iterator so the underlying EventEmitter listener is removed:
 *
 *   - The simplest path: iterate with `for await` and `break` / `return`
 *     out of the loop. JS calls `.return()` on the generator
 *     automatically when the loop is exited via break / return / throw.
 *   - Manual: call `await iterator.return(undefined)` from a finally /
 *     cleanup block. `routes/events.ts` does this in its SSE
 *     disconnect path.
 *
 * The `try/finally` blocks below are belt-and-braces: if a downstream
 * generator is constructed but never iterated, the inner `on()` iterator
 * still gets closed when this function's frame unwinds. Without it, a
 * subscriber that forgets to close would keep the listener attached for
 * the life of the process, slowly counting against `setMaxListeners()`.
 */
export async function* subscribe(
  options?: SubscribeOptions,
): AsyncGenerator<ItemEventWithId> {
  const iter = on(emitter, "ITEM_CHANGED");
  try {
    for await (const [event] of iter) {
      const itemEvent = event as ItemEventWithId;
      if (options?.typeFilter && itemEvent.item.type !== options.typeFilter)
        continue;
      if (options?.tenantId && itemEvent.tenantId !== options.tenantId)
        continue;
      yield itemEvent;
    }
  } finally {
    // `on()` returns a manual async iterator; calling .return() detaches
    // its EventEmitter listener. Best-effort — never throws.
    if (typeof iter.return === "function") {
      await iter.return();
    }
  }
}

/** Subscribe to edge lifecycle events. Filters by tenant only; there is
 *  no typeFilter since edges don't carry a content type.
 *  Same iterator cleanup contract as `subscribe()` above. */
export async function* subscribeEdges(options?: {
  tenantId?: string;
}): AsyncGenerator<EdgeEventWithId> {
  const iter = on(emitter, "EDGE_CHANGED");
  try {
    for await (const [event] of iter) {
      const edgeEvent = event as EdgeEventWithId;
      if (options?.tenantId && edgeEvent.tenantId !== options.tenantId)
        continue;
      yield edgeEvent;
    }
  } finally {
    if (typeof iter.return === "function") {
      await iter.return();
    }
  }
}

// Keep isEdgeEvent exported-private to consumers that type-narrow on the union.
export { isEdgeEvent };
