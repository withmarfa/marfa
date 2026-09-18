import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import { typeAnswersSubtreeFilter } from "@withmarfa/shared";
import { envNumber } from "./config.js";
import { log } from "./middleware/logger.js";
import type { EventLogStore } from "./storage/interface.js";

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

export interface ItemEvent extends FanoutControl {
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

export interface EdgeEvent extends FanoutControl {
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

let eventLogStore: EventLogStore | null = null;
let notifyRemote: ((eventId: bigint) => Promise<void>) | null = null;

export interface InitEventLogOptions {
  /**
   * Cross-process announcement of a freshly-appended event, fired after
   * the event_log append with the id it assigned. The Postgres wiring
   * issues pg_notify on the request-context connection, so the
   * announcement joins the surrounding transaction and is delivered only
   * on commit. Unset on SQLite, where one process is the deployment.
   */
  notifyRemote?: (eventId: bigint) => Promise<void>;
}

/** Call once at startup to enable event persistence. */
export function initEventLog(
  store: EventLogStore,
  options?: InitEventLogOptions,
): void {
  eventLogStore = store;
  notifyRemote = options?.notifyRemote ?? null;
}

/**
 * Reset the event-log wiring (test-only). Detaches the remote-announcement
 * hook, so a test that wired a notifier over a since-dropped database does
 * not leave it bound for whatever runs next in the same process, and the
 * store itself, so a test that wired the log to its own context does not
 * leave it bound for everything that runs afterwards in the same file.
 */
export function __resetEventLogForTests(): void {
  notifyRemote = null;
  eventLogStore = null;
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
 * The space an event belongs to: the row's own, falling back to the caller's.
 *
 * **A caller's space and its rows' space are the same thing right up until
 * they are not.** Storage is space-scoped at the SQL layer, so for an ordinary
 * space-bound credential a row it read is already in its own space and this
 * changes nothing. The operator key is not space-bound: its `space_id` is
 * null, so every door that took the space from the credential published
 * unscoped whenever it wrote to somebody else's rows.
 *
 * An unscoped event is not a broadly-delivered one. `subscribeItems` drops an
 * event whose space does not match a space-bound subscriber's, so the account
 * whose rows were written was the one account not told — while the unscoped
 * admin, matching nothing, received everything. The event log is worse than
 * the stream: its read is `space_id = ?`, which SQL never matches against
 * NULL, so a frame written unscoped can never be replayed to the owner's
 * cursor and no gap signal reports it.
 *
 * Deriving here rather than at each door is what closes the class. The
 * fallback direction is what makes it safe: a genuinely space-less row keeps
 * the caller's space, so this can only ever widen correctness and never
 * narrow an event that is delivered correctly today.
 */
function spaceForEvent(
  row: { space_id?: string | null },
  declared: string | undefined,
): string | undefined {
  const own = row.space_id ?? undefined;
  if (own !== undefined && declared !== undefined && own !== declared) {
    // Neither is null, and they disagree. That is a door addressing an event
    // somewhere its row does not live, which is always a bug — reported
    // rather than thrown, because this runs after the write has committed and
    // a throw would turn a mis-addressed event into a failed write.
    log("warn", "Event addressed to a space its row does not belong to", {
      item_id: (row as { id?: string }).id,
      row_space: own,
      declared_space: declared,
    });
  }
  return own ?? declared;
}

export async function publish(input: ItemEvent): Promise<bigint | undefined> {
  const spaceId = spaceForEvent(input.item, input.spaceId);
  const event: ItemEvent = {
    ...input,
    ...(spaceId !== undefined && { spaceId }),
  };
  const enableFanout = fansOut(event);

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
      enable_fanout: enableFanout,
    });
  }

  await announceRemote(eventId);

  emitter.emit("ITEM_CHANGED", {
    ...event,
    enableFanout,
    eventId,
  });
  return eventId;
}

/**
 * Publish an edge lifecycle event. Persists via event_log with
 * item_id = null and edge_id = edge.id.
 *
 * A type filter on the SSE stream narrows item events and leaves these
 * alone: an edge carries no item type, so `?type=` has nothing to say
 * about one, and a client watching two types needs to hear about the
 * edges joining them. `?edges=none` is the opt-out, and it is
 * independent of the type filter. Silencing every edge whenever a type
 * filter was set is the behavior this replaced, and it left a filtered
 * client with no way to reconstruct its graph — an edge has no row to
 * re-read and leaves no tombstone when it goes.
 */
export async function publishEdge(
  input: EdgeEvent,
): Promise<bigint | undefined> {
  const spaceId = spaceForEvent(input.edge, input.spaceId);
  const event: EdgeEvent = {
    ...input,
    ...(spaceId !== undefined && { spaceId }),
  };
  const enableFanout = fansOut(event);

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
      enable_fanout: enableFanout,
    });
  }

  await announceRemote(eventId);

  emitter.emit("EDGE_CHANGED", {
    ...event,
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
  /** One type, or several. A list is answered by any entry matching, so
   *  the subtree rule above applies per entry rather than to the list. */
  typeFilter?: string | readonly string[];
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
 * Resolved by `typeAnswersSubtreeFilter`, which is the same rule `/items`,
 * `/search` and `/export` compile into SQL for this parameter: the global
 * wildcard, the named type and everything under its name, and the types
 * that declare their way there. Deferring to it rather than restating it
 * is the whole point — this used to walk declared parentage alone, so the
 * stream answered a narrower question than every other surface reading the
 * same parameter, and answered it with an empty stream and a 200 rather
 * than with an error.
 *
 * **`spaceId` is what makes the answer true for the caller's own types.**
 * A space's subtype of a shipped type resolves only through the space's
 * overlay, so a matcher called without one classifies core and system
 * types and quietly misses everything the space registered for itself.
 * Both delivery paths pass it, and they must keep passing the same value
 * or a reconnect narrows a view the live stream had been serving in full.
 *
 * **What resolving the registry per live event costs, and what that was
 * judged against.** The yardstick is `matchesTypeFilter`, the permission
 * projection the stream already applies to every item event on the line
 * above this one: nothing costing a fraction of a call this path is
 * already making per event needs a cache in front of it. Measured over
 * two million calls against a space holding twenty custom types, one of
 * them declaring a shipped parent from outside its namespace:
 *
 *   - name clause answers (`core.media` / `core.media.song`)     ~18ns
 *   - registry walk, declared parent through the overlay         ~38ns
 *   - registry walk, answering no                                ~30ns
 *   - `matchesTypeFilter`, already paid per event               ~146ns
 *
 * So the walk is about a quarter of a cost this path already pays, and
 * the common case — an event whose type sits under the filter's own
 * namespace, which never consults the registry at all — is an eighth of
 * it. Absolute figures were taken on a loaded machine and are therefore
 * pessimistic; the ratios are what the judgment rests on, and a busy
 * machine moves both sides of a ratio together.
 *
 * A list answers when any entry answers, so the subtree rule is applied
 * per entry rather than to the list. An empty list is not a filter that
 * admits nothing — the route never builds one, and reading it as "no
 * types" would turn a trailing comma into a silent, permanent outage.
 *
 * Named rather than inlined because it is a rule a test can hold directly;
 * asserting it through the subscription loop means racing that loop's own
 * iterator, which tests the harness more than the rule.
 */
export function eventMatchesTypeFilter(
  eventType: string,
  filter: string | readonly string[] | undefined,
  spaceId?: string | null,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string")
    return typeAnswersSubtreeFilter(eventType, filter, spaceId);
  if (filter.length === 0) return true;
  return filter.some((entry) =>
    typeAnswersSubtreeFilter(eventType, entry, spaceId),
  );
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
      // Space first, and the order matters now: this is a string
      // comparison while the type filter below may walk a declared chain
      // through the registry, so testing the cheap fence first keeps the
      // expensive question off every event belonging to another space.
      if (options?.spaceId && itemEvent.spaceId !== options.spaceId) continue;
      // The space goes to the matcher, or a space's own subtype of a
      // shipped type does not answer a filter naming that type. `?? null`
      // rather than passing the value through: the list surfaces resolve
      // a space-less caller against the null-space overlay a platform
      // self-host registers into, and a stream resolving it against core
      // types alone would disagree with them for exactly those
      // deployments. It also matters that this is not `undefined`, which
      // the matcher reads as "resolve names only".
      if (
        !eventMatchesTypeFilter(
          itemEvent.item.type,
          options?.typeFilter,
          options?.spaceId ?? null,
        )
      )
        continue;
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
