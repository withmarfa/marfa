import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import { envNumber } from "./config.js";
import { cycleRequestContext } from "./cycle-context.js";
import type { EventLogStore, Storage } from "./storage/interface.js";

/**
 * Cycle-detection metadata carried on every published event.
 * The chain is detected through two fields:
 *
 *   - `originatingConnectionId` is set when the chain was kicked off by
 *     a connector (not a human). It propagates verbatim down the chain.
 *   - `hopCount` increments on each reactive publish; pubsub.publish()
 *     drops events whose hop_count would exceed the space's
 *     `max_event_hop_budget` (default 5).
 *
 * Events originating from a human caller MUST resolve to
 * `{ originatingConnectionId: null, hopCount: 0 }`.
 *
 * **Request-scoped resolution.** Callers don't thread cycle metadata
 * explicitly on every `publish(...)`. `cycleMiddleware` stores the
 * resolved cycle in `cycleRequestContext` at request entry; `publish`
 * and `publishEdge` consult it automatically. The optional
 * `originatingConnectionId` / `hopCount` fields on event args remain
 * supported as an explicit override for the rare server-internal publish
 * that needs to synthesize its own cycle. If either field is present,
 * the explicit values win; otherwise the ALS is consulted; outside any
 * request (background workers) the resolver falls through to the human
 * sentinel.
 */
export interface CycleMetadata {
  originatingConnectionId?: string | null;
  hopCount?: number;
}

/**
 * Resolve the cycle metadata to stamp on an emitted event.
 *
 * Order:
 *
 *   1. **Explicit override** — caller passed `originatingConnectionId`
 *      or `hopCount` on the event arg. The explicit values win; missing
 *      siblings default to `null` / `0`.
 *   2. **ALS** — `cycleRequestContext.getStore()` set by
 *      `cycleMiddleware`. The normal path inside a request handler.
 *   3. **Sentinel** — outside any request AND no explicit override:
 *      `{ null, 0 }`. The human-chain-head shape; bypasses the budget.
 *
 * The function is purely internal; the event arg's optional fields are
 * the public contract.
 */
function resolveCycleForPublish(event: CycleMetadata): {
  originatingConnectionId: string | null;
  hopCount: number;
} {
  const hasExplicit = "originatingConnectionId" in event || "hopCount" in event;
  if (hasExplicit) {
    return {
      originatingConnectionId: event.originatingConnectionId ?? null,
      hopCount: event.hopCount ?? 0,
    };
  }
  const ctx = cycleRequestContext.getStore();
  if (ctx) return ctx;
  return { originatingConnectionId: null, hopCount: 0 };
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
  spaceId?: string;
}

export interface EdgeEvent extends CycleMetadata {
  type: "edge_created" | "edge_deleted";
  edge: Edge;
  spaceId?: string;
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

/**
 * Process-local event bus, and the sole distribution channel for Server-Sent
 * Events and outbound webhook dispatch.
 *
 * **This makes one server process per database a hard requirement.** A second
 * process publishing here reaches only its own subscribers, so an SSE client
 * or webhook consumer attached to a different process never sees the event. It
 * fails silently in every direction: the write commits, the API returns 200,
 * nothing logs, nothing retries, and the event is gone. `multi-replica-check.ts`
 * warns at boot where the topology can be detected, and the self-hosting
 * documentation states the constraint for the cases it cannot.
 *
 * Making this safe across processes means moving distribution to a shared
 * broker (Postgres LISTEN/NOTIFY, or an external bus). That is a substantial
 * change and deliberately not attempted here.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(envNumber(process.env.MAX_SUBSCRIPTION_LISTENERS, 100));

/** Default hop budget when the space has no override configured. */
export const DEFAULT_HOP_BUDGET = 5;

let eventLogStore: EventLogStore | null = null;
let getHopBudget: (spaceId: string | undefined) => Promise<number> = () =>
  Promise.resolve(DEFAULT_HOP_BUDGET);
let onHopOverflow:
  | ((event: PubsubEvent, budget: number) => Promise<void>)
  | null = null;

export interface InitEventLogOptions {
  /**
   * Resolve the per-space hop budget. Defaults to `DEFAULT_HOP_BUDGET`.
   * Hosted-mode wiring reads `spaces.getConfig(...).max_event_hop_budget`.
   */
  getHopBudget?: (spaceId: string | undefined) => Promise<number>;
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
 * Helper for connector reaction handlers (exported here so the contract
 * is in one place). Returns the cycle
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
 * TTL for the per-space hop-budget cache. The publish path hits this
 * lookup on every reactive (hopCount > 0) event; without caching, every
 * such publish triggers a `storage.spaces.getConfig` round-trip which
 * is a real DB hit on hosted Postgres. 30s is the trade-off: long enough
 * to absorb burst traffic at near-zero cost; short enough that an
 * operator's `PUT /spaces/me/config` change to `max_event_hop_budget`
 * propagates within a window the operator can tolerate.
 */
const HOP_BUDGET_TTL_MS = 30_000;

/**
 * Build the InitEventLogOptions wiring from a Storage instance. The
 * server's bootstrap calls this; tests can opt in or pass their own
 * stubs.
 *
 * The `getHopBudget` resolver is wrapped in a per-space TTL cache so
 * the publish hot path doesn't hit storage on every reactive event.
 */
export function defaultCycleDetectionWiring(
  storage: Storage,
): InitEventLogOptions {
  // Per-space budget cache. Sized by space count, expires per-entry on
  // first access past `HOP_BUDGET_TTL_MS`.
  const budgetCache = new Map<string, { value: number; expiresAt: number }>();

  const lookupBudget = async (spaceId: string): Promise<number> => {
    const now = Date.now();
    const cached = budgetCache.get(spaceId);
    if (cached && cached.expiresAt > now) return cached.value;
    if (!storage.spaces) return DEFAULT_HOP_BUDGET;
    const cfg = await storage.spaces.getConfig(spaceId);
    const value = cfg?.max_event_hop_budget ?? DEFAULT_HOP_BUDGET;
    budgetCache.set(spaceId, { value, expiresAt: now + HOP_BUDGET_TTL_MS });
    return value;
  };

  return {
    getHopBudget: async (spaceId) => {
      // No space scope (keys-mode self-host) → constant default; skip
      // the cache entirely.
      if (!spaceId) return DEFAULT_HOP_BUDGET;
      return lookupBudget(spaceId);
    },
    onHopOverflow: async (event, budget) => {
      // Emit a `system.activity` row directly via storage.items.create —
      // bypassing pubsub.publish so the activity isn't itself fed back
      // into the bus and re-counted toward the budget.
      const spaceId = event.spaceId;
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
          spaceId,
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
 * Resolve the per-space hop budget without invoking the publish path.
 * Public counterpart to the module-private `getHopBudget` so debug
 * surfaces (e.g. preview-event) can report what the budget would be
 * for a space. Falls back to `DEFAULT_HOP_BUDGET` in keys-mode (no
 * space scope) and when the wiring isn't initialized (tests).
 */
export async function resolveHopBudget(
  spaceId: string | undefined,
): Promise<number> {
  return getHopBudget(spaceId);
}

/**
 * Check whether the event would exceed the space's hop budget. When it
 * does, fire the overflow hook and return false so the caller skips
 * persistence + emission. Returns true on the happy path.
 *
 * Attribution is by `originatingConnectionId !== null` — NOT by
 * `hopCount`. A misbehaving (or hostile) wire-level publish that ships
 * `hopCount: 0` plus an `originatingConnectionId` set would otherwise
 * short-circuit the budget. The contract per `nextHopMetadata` is
 * `hopCount >= 1` whenever origin is set; any event that violates it
 * gets treated as `hopCount = 1` so the budget gate still applies.
 *
 * The `cycle` argument is the already-resolved cycle (post-ALS /
 * explicit-override resolution from `resolveCycleForPublish`); callers
 * must not pass the raw event's optional fields.
 */
/**
 * Resolve the hop count the budget gate should enforce against. For
 * connector-originated events (origin set) it applies a floor of 1 so a
 * malformed wire publish that stamps origin but leaves hopCount at 0
 * doesn't slip past the budget. ALS-driven propagation means in-process
 * callers can't produce this shape, but a tampered inbound header still
 * can — so the floor stays as wire-tampering defense. Human-originated
 * events (no origin) pass their hopCount through unchanged.
 *
 * Shared by `passesHopBudget` and the `POST /connections/preview-event`
 * hypothetical-event reasoning so the two can't drift.
 */
export function computeEffectiveHopCount(cycle: {
  originatingConnectionId: string | null;
  hopCount: number;
}): number {
  const isConnectorOriginated = cycle.originatingConnectionId != null;
  return isConnectorOriginated ? Math.max(cycle.hopCount, 1) : cycle.hopCount;
}

async function passesHopBudget(
  event: PubsubEvent,
  cycle: { originatingConnectionId: string | null; hopCount: number },
): Promise<boolean> {
  const isConnectorOriginated = cycle.originatingConnectionId != null;
  // Human-originated events (no origin, no hops) bypass the budget.
  if (!isConnectorOriginated && cycle.hopCount === 0) return true;
  const effectiveHopCount = computeEffectiveHopCount(cycle);
  const budget = await getHopBudget(event.spaceId);
  if (effectiveHopCount <= budget) return true;
  if (onHopOverflow) {
    try {
      // The overflow hook receives the event annotated with the
      // resolved cycle so the system.activity row carries the right
      // origin / hopCount even when the caller relied on ALS / sentinel.
      const annotated: PubsubEvent = {
        ...event,
        originatingConnectionId: cycle.originatingConnectionId,
        hopCount: cycle.hopCount,
      };
      await onHopOverflow(annotated, budget);
    } catch {
      // Swallow — overflow handler errors don't propagate.
    }
  }
  return false;
}

export async function publish(event: ItemEvent): Promise<bigint | undefined> {
  const cycle = resolveCycleForPublish(event);
  if (!(await passesHopBudget(event, cycle))) return undefined;

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
      space_id: event.spaceId,
      payload,
      originating_connection_id: cycle.originatingConnectionId,
      hop_count: cycle.hopCount,
    });
  }

  emitter.emit("ITEM_CHANGED", {
    ...event,
    originatingConnectionId: cycle.originatingConnectionId,
    hopCount: cycle.hopCount,
    eventId,
  });
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
  const cycle = resolveCycleForPublish(event);
  if (!(await passesHopBudget(event, cycle))) return undefined;

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
      space_id: event.spaceId,
      payload,
      originating_connection_id: cycle.originatingConnectionId,
      hop_count: cycle.hopCount,
    });
  }

  emitter.emit("EDGE_CHANGED", {
    ...event,
    originatingConnectionId: cycle.originatingConnectionId,
    hopCount: cycle.hopCount,
    eventId,
  });
  return eventId;
}

export interface SubscribeOptions {
  typeFilter?: string;
  spaceId?: string;
}

/**
 * Iterator cleanup contract.
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
      if (options?.spaceId && itemEvent.spaceId !== options.spaceId) continue;
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

/** Subscribe to edge lifecycle events. Filters by space only; there is
 *  no typeFilter since edges don't carry a content type.
 *  Same iterator cleanup contract as `subscribe()` above. */
export async function* subscribeEdges(options?: {
  spaceId?: string;
}): AsyncGenerator<EdgeEventWithId> {
  const iter = on(emitter, "EDGE_CHANGED");
  try {
    for await (const [event] of iter) {
      const edgeEvent = event as EdgeEventWithId;
      if (options?.spaceId && edgeEvent.spaceId !== options.spaceId) continue;
      yield edgeEvent;
    }
  } finally {
    if (typeof iter.return === "function") {
      await iter.return();
    }
  }
}

export { isEdgeEvent };
