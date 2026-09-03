import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import { isSubtypeOf } from "@withmarfa/shared";
import { envNumber } from "./config.js";
import { cycleRequestContext } from "./cycle-context.js";
import { log } from "./middleware/logger.js";
import type { EventLogStore, Storage } from "./storage/interface.js";

/**
 * Cycle-detection metadata carried on every published event.
 * The chain is detected through two fields:
 *
 *   - `originatingConnectionId` is set when the chain was kicked off by
 *     an integration (not a human). It propagates verbatim down the chain.
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

/**
 * Whether this event drives outbound side effects as well as being logged
 * and streamed: outbound webhook delivery, and the integration reactions
 * the reactive bridge enqueues.
 *
 * Absent means yes, so every ordinary write door is unchanged. The bulk
 * doors default it off, because one call there writes thousands of rows
 * and a delivery per row per subscriber is work nobody asked for.
 *
 * It never governs the event log or the stream. Those are what a client
 * rebuilding its state reads, so a write kept out of them is a write that
 * client can never learn about; the expense being managed here is the
 * outbound work, not the record.
 */
export interface FanoutControl {
  enableFanout?: boolean;
}

/**
 * Whether an event should drive outbound side effects. Absent reads as yes,
 * so every ordinary write door needs to say nothing.
 *
 * An event rebuilt from a persisted row carries the answer its writer gave,
 * because `event_log` stores it. That is load-bearing rather than tidy: the
 * reactive bridge's drainer is elected across the cluster, so on a split
 * deployment the process that reacts is routinely not the process that
 * wrote, and it knows only what the row tells it. Rows written before the
 * column read as fanning out, which is what they did.
 */
export function fansOut(event: FanoutControl): boolean {
  return event.enableFanout !== false;
}

export interface ItemEvent extends CycleMetadata, FanoutControl {
  type:
    | "created"
    | "updated"
    | "deleted"
    | "restored"
    | "purged"
    | "state_changed"
    | "metadata_changed";
  item: Item;
  metadata?: Metadata;
  spaceId?: string;
}

export interface EdgeEvent extends CycleMetadata, FanoutControl {
  type: "edge_created" | "edge_updated" | "edge_deleted";
  edge: Edge;
  spaceId?: string;
}

export type PubsubEvent = ItemEvent | EdgeEvent;

export interface ItemEventWithId extends ItemEvent {
  /** event_log.id assigned by storage. `bigint` so values above
   *  Number.MAX_SAFE_INTEGER round-trip without truncation. */
  eventId?: bigint;
  /**
   * True when this event was published by ANOTHER process and replicated
   * here through the database (see event-replication.ts). Subscribers
   * that produce side effects exactly once per event — outbound webhook
   * delivery — skip remote events, because the origin process already
   * produced them; pure fan-out (SSE, the reactive bridge's elected
   * drainer) treats local and remote alike.
   */
  remote?: boolean;
}

export interface EdgeEventWithId extends EdgeEvent {
  /** event_log.id assigned by storage. `bigint` — see ItemEventWithId. */
  eventId?: bigint;
  /** Replicated from another process — see ItemEventWithId.remote. */
  remote?: boolean;
}

export type PubsubEventWithId = ItemEventWithId | EdgeEventWithId;

/**
 * Process-local event bus: the distribution channel for Server-Sent
 * Events, outbound webhook dispatch, and the reactive bridges.
 *
 * On Postgres this emitter is no longer the whole story. `publish()`
 * announces every appended event over pg_notify (the `notifyRemote` hook,
 * wired by index.ts to event-replication.ts), and every sibling process
 * hydrates the announcement from event_log and re-emits it here marked
 * `remote: true` — so a subscriber on any process sees the deployment's
 * events, not one process's. Subscribers with exactly-once side effects
 * (webhook delivery) skip remote events; pure fan-out treats local and
 * remote alike. On SQLite one process is the deployment and no hook is
 * wired, which restores the old purely-local behavior by construction.
 *
 * What still assumes few processes lives elsewhere: the in-memory
 * per-email throttle, the rate-limit and space-cap caches, and the
 * `last_used_at` debounce all tolerate multiple copies (they degrade to
 * per-process granularity) but are not shared state. The realtime loss
 * that made one process a hard requirement is what this closes.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(envNumber(process.env.MAX_SUBSCRIPTION_LISTENERS, 100));

/** Default hop budget when the space has no override configured. */
export const DEFAULT_HOP_BUDGET = 5;

let eventLogStore: EventLogStore | null = null;
let getHopBudget: (spaceId: string | undefined) => Promise<number> = () =>
  Promise.resolve(DEFAULT_HOP_BUDGET);
let onHopOverflow:
  ((event: PubsubEvent, budget: number) => Promise<void>) | null = null;
let notifyRemote: ((eventId: bigint) => Promise<void>) | null = null;

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
  /**
   * Cross-process announcement of a freshly-appended event, fired after
   * the event_log append with the id it assigned. The Postgres wiring
   * issues pg_notify on the request-context connection, so the
   * announcement joins the surrounding transaction and is delivered only
   * on commit. Unset on SQLite, where one process is the deployment.
   */
  notifyRemote?: (eventId: bigint) => Promise<void>;
}

/** Call once at startup to enable event persistence + cycle detection. */
export function initEventLog(
  store: EventLogStore,
  options?: InitEventLogOptions,
): void {
  eventLogStore = store;
  if (options?.getHopBudget) getHopBudget = options.getHopBudget;
  if (options?.onHopOverflow) onHopOverflow = options.onHopOverflow;
  notifyRemote = options?.notifyRemote ?? null;
}

/**
 * Reset the cycle-detection wiring (test-only). Restores the default
 * hop-budget callback and clears the overflow hook.
 */
export function __resetCycleDetectionForTests(): void {
  getHopBudget = () => Promise.resolve(DEFAULT_HOP_BUDGET);
  onHopOverflow = null;
  // Also detaches the remote-announcement hook: a test that wired a
  // notifier over a since-dropped database must not leave it bound for
  // whatever runs next in the same process.
  notifyRemote = null;
  // And the store itself. `initEventLog` sets four pieces of module state and
  // this used to restore three, so a test that wired the log to its own
  // context left the store bound to it for everything that ran afterwards in
  // the same file. Files are forked apart, so it could never cross one, which
  // is exactly what made it the kind of thing found by reading rather than by
  // a failure.
  eventLogStore = null;
}

/**
 * Helper for integration reaction handlers (exported here so the contract
 * is in one place). Returns the cycle
 * metadata to stamp on a downstream event when reacting to a parent —
 * propagates `originatingConnectionId` (taking the parent's, or stamping
 * the current integration's if the chain starts here) and increments
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
 *     purged / state_changed)
 *   metadata.changed (bare, not namespaced) for metadata mutations —
 *     a deliberate exception because it describes a metadata-layer change
 *   edge.created / edge.updated / edge.deleted for edge lifecycle events
 *
 * Mirrored by routes/events.ts, webhooks/delivery.ts, and
 * routes/webhooks.ts so SSE wire, webhook payloads, and subscription
 * validation all agree.
 */
export function wireEventName(type: PubsubEvent["type"]): string {
  if (type === "metadata_changed") return "metadata.changed";
  if (type === "edge_created") return "edge.created";
  if (type === "edge_updated") return "edge.updated";
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
 * integration-originated events (origin set) it applies a floor of 1 so a
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
  const isIntegrationOriginated = cycle.originatingConnectionId != null;
  return isIntegrationOriginated ? Math.max(cycle.hopCount, 1) : cycle.hopCount;
}

/**
 * Whether this event is inside the space's hop budget.
 *
 * A pure question, deliberately: the answer is needed *before* the event log
 * append, because the append records it, while the overflow hook it used to
 * fire is a write of its own and must happen once. Splitting them is what
 * lets the budget decide `enable_fanout` rather than decide whether to emit.
 */
async function withinHopBudget(
  event: PubsubEvent,
  cycle: { originatingConnectionId: string | null; hopCount: number },
): Promise<{ within: boolean; budget: number }> {
  const isIntegrationOriginated = cycle.originatingConnectionId != null;
  const budget = await getHopBudget(event.spaceId);
  // Human-originated events (no origin, no hops) bypass the budget.
  if (!isIntegrationOriginated && cycle.hopCount === 0) {
    return { within: true, budget };
  }
  return { within: computeEffectiveHopCount(cycle) <= budget, budget };
}

/** Record an overflow. Best-effort; a failure here never reaches the caller. */
async function recordHopOverflow(
  event: PubsubEvent,
  cycle: { originatingConnectionId: string | null; hopCount: number },
  budget: number,
): Promise<void> {
  if (!onHopOverflow) return;
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

/**
 * What the budget decides, and what it does not.
 *
 * It decides whether the event drives outbound work — the integration
 * reactions that are the loop it exists to bound. It does not decide whether
 * the event is logged, and no longer decides whether it is emitted.
 *
 * Emitting it is what makes the stream consistent: an over-budget row is in
 * the log, so a client replaying from a cursor receives it, and suppressing
 * the live emit meant the same event id behaved differently depending on
 * when you connected. Suppressing only the fan-out is the property actually
 * wanted, and because it rides the row it survives replication — the
 * replicator's reconnect catch-up re-emits every row it finds above its
 * anchor with no budget check of its own, which was quietly advancing every
 * stalled chain one hop per reconnect.
 */
async function resolveFanout(
  event: PubsubEvent,
  cycle: { originatingConnectionId: string | null; hopCount: number },
): Promise<boolean> {
  const { within, budget } = await withinHopBudget(event, cycle);
  if (!within) await recordHopOverflow(event, cycle, budget);
  return fansOut(event) && within;
}

export async function publish(event: ItemEvent): Promise<bigint | undefined> {
  const cycle = resolveCycleForPublish(event);
  const enableFanout = await resolveFanout(event, cycle);

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
      enable_fanout: enableFanout,
    });
  }

  await announceRemote(eventId);

  emitter.emit("ITEM_CHANGED", {
    ...event,
    originatingConnectionId: cycle.originatingConnectionId,
    hopCount: cycle.hopCount,
    enableFanout,
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
  const enableFanout = await resolveFanout(event, cycle);

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
      enable_fanout: enableFanout,
    });
  }

  await announceRemote(eventId);

  emitter.emit("EDGE_CHANGED", {
    ...event,
    originatingConnectionId: cycle.originatingConnectionId,
    hopCount: cycle.hopCount,
    enableFanout,
    eventId,
  });
  return eventId;
}

/**
 * Tell sibling processes an event landed, so their subscribers see the
 * deployment's events rather than one process's.
 *
 * A failed announcement must not suppress local delivery: outside a request
 * transaction the append has already committed, and inside one a failed
 * statement aborts the transaction regardless — either way this process's
 * own subscribers keep the event they always got.
 */
async function announceRemote(eventId: bigint | undefined): Promise<void> {
  if (eventId === undefined || !notifyRemote) return;
  try {
    await notifyRemote(eventId);
  } catch (err) {
    logRemoteNotifyFailure(eventId, err);
  }
}

function logRemoteNotifyFailure(eventId: bigint, err: unknown): void {
  log("warn", "Remote event announcement failed; siblings missed one", {
    event_id: String(eventId),
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Emit an event into this process's subscribers without persisting or
 * announcing it. For in-process wake sentinels only — a shutdown wake
 * has to unblock local for-await loops, and it neither belongs in
 * event_log nor deserves broadcast to sibling processes as a fabricated
 * event on every rolling deploy.
 */
export function emitWake(event: PubsubEventWithId): void {
  // `isEdgeEvent` rather than a list of edge type names. Both this and
  // `emitReplicated` enumerated the two that existed, so adding a third
  // meant remembering two sites that mention neither edges nor events in
  // their names — and an event routed to the wrong emitter is delivered to
  // nobody rather than failing. The discriminant is the payload shape,
  // which cannot fall behind the union.
  if (isEdgeEvent(event)) {
    emitter.emit("EDGE_CHANGED", event);
  } else {
    emitter.emit("ITEM_CHANGED", event);
  }
}

/**
 * Emit an event replicated from another process into this process's
 * subscribers, marked `remote: true`. No event_log append and no remote
 * announcement: the origin process did both, and repeating either here
 * would duplicate the row or echo the event around the cluster forever.
 * Only event-replication.ts calls this.
 */
export function emitReplicated(event: PubsubEventWithId): void {
  const marked = { ...event, remote: true };
  // Shape, not a name list — see `emitWake`.
  if (isEdgeEvent(event)) {
    emitter.emit("EDGE_CHANGED", marked);
  } else {
    emitter.emit("ITEM_CHANGED", marked);
  }
}

export interface SubscribeOptions {
  typeFilter?: string;
  spaceId?: string;
  /**
   * Detaches the underlying emitter listener the moment it aborts.
   * Without it a departed subscriber's listener survives until the next
   * event MATCHING its filters arrives to resume the generator —
   * `iterator.return()` alone cannot unwind a generator suspended on an
   * event that never comes, so a quiet space accumulates one listener
   * per departed viewer indefinitely. Long-lived per-request consumers
   * (the SSE route) pass one; process-lifetime consumers (the webhook
   * consumer, the bridges) do not need to.
   */
  signal?: AbortSignal;
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
/**
 * Whether an event's item type answers a `?type=` subscription filter.
 *
 * A subtree, not a string match: `core.media` answers for
 * `core.media.song`, exactly as `/items`, `/search` and `/export` resolve
 * the same parameter, and exactly as the realtime guide describes the
 * stream. This was a `!==` comparison, so a subscriber narrowing to a
 * parent type silently received nothing — the one read surface in the API
 * resolving a type differently from every other.
 *
 * Named rather than inlined because it is a rule a test can hold directly;
 * asserting it through the subscription loop means racing that loop's own
 * iterator, which tests the harness more than the rule.
 */
export function eventMatchesTypeFilter(
  eventType: string,
  filter: string | undefined,
  spaceId?: string | null,
): boolean {
  if (!filter) return true;
  return isSubtypeOf(eventType, filter, spaceId);
}

export async function* subscribe(
  options?: SubscribeOptions,
): AsyncGenerator<ItemEventWithId> {
  const iter = on(
    emitter,
    "ITEM_CHANGED",
    options?.signal ? { signal: options.signal } : undefined,
  );
  try {
    for await (const [event] of iter) {
      const itemEvent = event as ItemEventWithId;
      if (!eventMatchesTypeFilter(itemEvent.item.type, options?.typeFilter))
        continue;
      if (options?.spaceId && itemEvent.spaceId !== options.spaceId) continue;
      yield itemEvent;
    }
  } catch (err) {
    // An aborted signal rejects the pending next() with AbortError —
    // that is the subscription ending, not a failure.
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
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
  signal?: AbortSignal;
}): AsyncGenerator<EdgeEventWithId> {
  const iter = on(
    emitter,
    "EDGE_CHANGED",
    options?.signal ? { signal: options.signal } : undefined,
  );
  try {
    for await (const [event] of iter) {
      const edgeEvent = event as EdgeEventWithId;
      if (options?.spaceId && edgeEvent.spaceId !== options.spaceId) continue;
      yield edgeEvent;
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    if (typeof iter.return === "function") {
      await iter.return();
    }
  }
}

export { isEdgeEvent };
