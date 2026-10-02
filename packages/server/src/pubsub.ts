import { EventEmitter, on } from "node:events";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import { typeAnswersSubtreeFilter } from "@withmarfa/shared";
import type { CascadeRoot, EventLogStore } from "./storage/interface.js";
import { afterCommit } from "./storage/commit-hooks.js";

/**
 * Whether this event drives outbound side effects as well as being logged
 * and streamed: outbound webhook delivery.
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
 * because `event_log` stores it. That is load-bearing rather than tidy: a
 * catch-up rebuilds events from rows, and a rebuilt event that read as
 * fanning out when its writer said otherwise would be a different event
 * from the one that was emitted. Rows written before the column read as
 * fanning out, which is what they did.
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
  /** On `deleted` and `purged` of a row a cascade trashed: the row the
   *  trash named. */
  trashedWith?: CascadeRoot;
  /** On `restored` alone: the row whose restore brought this one back. */
  restoredWith?: CascadeRoot;
}

export interface EdgeEvent extends FanoutControl {
  type: "edge_created" | "edge_updated" | "edge_deleted";
  edge: Edge;
  /**
   * The source item's type when the event was published, which is what decides
   * who may be told about it (`edges.md` 23). Carried rather than looked up
   * by a subscriber, because a purge announces the edges it took after the
   * source row has gone, and a subscriber cannot look up a type nobody holds.
   *
   * Every door that publishes names it (`edge-events-every-door.test.ts`
   * holds them to it). Optional because a door announcing after its commit
   * can find the source already purged by a concurrent request: the event
   * is still logged and delivered to webhooks, and the stream withholds it
   * from every subscriber, since a source it cannot classify is not one it
   * may read.
   */
  sourceType?: string;
  /** On `edge_deleted` alone: the item whose purge took the edge. */
  purgedWith?: string;
}

export type PubsubEvent = ItemEvent | EdgeEvent;

/**
 * The frame as the log stores it: what a reader of every type is sent, plus
 * the type of each row a mark names, which `frameFor` reads and strips.
 */
export function storedFrame(event: PubsubEvent): Record<string, unknown> {
  if (isEdgeEvent(event)) {
    return {
      type: wireEventName(event.type),
      edge: event.edge,
      ...(event.sourceType !== undefined && { source_type: event.sourceType }),
      ...(event.purgedWith !== undefined && { purged_with: event.purgedWith }),
    };
  }
  const { trashedWith, restoredWith } = event;
  return {
    type: wireEventName(event.type),
    item: trashedWith
      ? { ...event.item, ...cascadeMark(trashedWith, () => true) }
      : event.item,
    ...(trashedWith && { trashed_with_type: trashedWith.type }),
    ...(restoredWith && {
      restored_with: restoredWith.id,
      restored_with_type: restoredWith.type,
    }),
    ...(event.metadata && { metadata: event.metadata }),
  };
}

/**
 * The mark on a row a cascade trashed: the flag to every reader, the id only
 * to one that may read the named row's type.
 */
export function cascadeMark(
  root: CascadeRoot,
  mayRead: (type: string) => boolean,
): { trashed_by_cascade: true; trashed_with?: string } {
  return {
    trashed_by_cascade: true,
    ...(mayRead(root.type) && { trashed_with: root.id }),
  };
}

/**
 * A mark stays only where its named row's type is readable, since a frame
 * decoded from the log gets no more trust than one built live.
 */
export function frameFor(
  stored: Record<string, unknown>,
  mayRead: (type: string) => boolean,
): Record<string, unknown> {
  const {
    trashed_with_type: trashedType,
    restored_with_type: restoredType,
    ...frame
  } = stored;
  const readable = (type: unknown): boolean =>
    typeof type === "string" && mayRead(type);
  const item: unknown = frame.item;
  if (typeof item === "object" && item !== null && "trashed_with" in item) {
    const { trashed_with: named, ...rest } = item as Record<string, unknown>;
    frame.item =
      typeof named === "string" && readable(trashedType) ? item : rest;
  }
  if ("restored_with" in frame && !readable(restoredType)) {
    delete frame.restored_with;
  }
  return frame;
}

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
 * Process-local event bus: the distribution channel for Server-Sent
 * Events and outbound webhook dispatch.
 *
 * Process-local, and that is the limit of it: a subscriber sees the events
 * its own process publishes and no others. There is no cross-process
 * fan-out, so a deployment running more than one process serves each
 * stream only what its own process wrote.
 */
const emitter = new EventEmitter();
// Each open event stream and the webhook delivery each listen here, so the
// count grows with the number of viewers, which is uncapped unless
// `MARFA_SSE_MAX_VIEWERS` caps it. Node's warning at a fixed count would
// fire on ordinary load rather than on a leak.
emitter.setMaxListeners(0);

let eventLogStore: EventLogStore | null = null;

/** Call once at startup to enable event persistence. */
export function initEventLog(store: EventLogStore): void {
  eventLogStore = store;
}

/**
 * Reset the event-log wiring (test-only). Detaches the store, so a test
 * that wired the log to its own context does not leave it bound for
 * everything that runs afterwards in the same file.
 */
export function __resetEventLogForTests(): void {
  eventLogStore = null;
}

/**
 * How many listeners the bus holds across both kinds (test-only): what a
 * subscription that closed properly leaves behind is nothing, and only a
 * count can say so.
 */
export function __listenerCountForTests(): number {
  return (
    emitter.listenerCount("ITEM_CHANGED") +
    emitter.listenerCount("EDGE_CHANGED")
  );
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
 * Record an item change in the event log and tell this process's
 * subscribers.
 *
 * **Called inside the transaction that wrote the change**, so the log row
 * commits with the change or not at all, and the log's ids follow commit
 * order. The subscribers are told only once that transaction commits, so a
 * rollback leaves nothing behind for one to act on. Called outside any
 * transaction, the change before it has already committed, and both happen
 * at once.
 */
export async function publish(event: ItemEvent): Promise<bigint | undefined> {
  const enableFanout = fansOut(event);

  let eventId: bigint | undefined;

  if (eventLogStore) {
    const payload = JSON.stringify(storedFrame(event));
    eventId = await eventLogStore.append({
      event_type: event.type,
      item_id: event.item.id,
      payload,
      enable_fanout: enableFanout,
    });
  }

  afterCommit(() => {
    emitter.emit("ITEM_CHANGED", {
      ...event,
      enableFanout,
      eventId,
    });
  });
  return eventId;
}

/**
 * Publish an edge lifecycle event, on the terms `publish` keeps. Persists
 * via event_log with item_id = null and edge_id = edge.id.
 *
 * A type filter on the SSE stream narrows item events and leaves these
 * alone: an edge carries no item type, so `?type=` has nothing to say
 * about one, and a client watching two types needs to hear about the
 * edges joining them. `?edges=none` is the opt-out, and it is
 * independent of the type filter. Silencing every edge under a type
 * filter would leave a filtered client with no way to reconstruct its
 * graph — an edge has no row to re-read and leaves no record when it
 * goes.
 */
export async function publishEdge(
  event: EdgeEvent,
): Promise<bigint | undefined> {
  const enableFanout = fansOut(event);

  let eventId: bigint | undefined;

  if (eventLogStore) {
    const payload = JSON.stringify(storedFrame(event));
    eventId = await eventLogStore.append({
      event_type: event.type,
      item_id: null,
      edge_id: event.edge.id,
      payload,
      enable_fanout: enableFanout,
    });
  }

  afterCommit(() => {
    emitter.emit("EDGE_CHANGED", {
      ...event,
      enableFanout,
      eventId,
    });
  });
  return eventId;
}

/**
 * Emit an event into this process's subscribers without persisting it.
 * For in-process wake sentinels only — a shutdown wake has to unblock
 * local for-await loops, and it does not belong in event_log.
 */
export function emitWake(event: PubsubEventWithId): void {
  // `isEdgeEvent` rather than a list of edge type names: a list has to be
  // kept in step with the union by hand, and an event routed to the wrong
  // emitter is delivered to nobody rather than failing. The payload shape
  // cannot fall behind.
  if (isEdgeEvent(event)) {
    emitter.emit("EDGE_CHANGED", event);
  } else {
    emitter.emit("ITEM_CHANGED", event);
  }
}

export interface SubscribeOptions {
  /** One type, or several. A list is answered by any entry matching, so
   *  the subtree rule above applies per entry rather than to the list. */
  typeFilter?: string | readonly string[];
  /**
   * Detaches the underlying emitter listener the moment it aborts.
   * Without it a departed subscriber's listener survives until the next
   * event MATCHING its filters arrives to resume the generator —
   * `iterator.return()` alone cannot unwind a generator suspended on an
   * event that never comes, so a quiet instance accumulates one listener
   * per departed viewer indefinitely. Long-lived per-request consumers
   * (the SSE route) pass one to `subscribeAll`, and the webhook consumer
   * hands the one its `stop()` aborts to both of its loops.
   */
  signal?: AbortSignal;
}

/**
 * Iterator cleanup contract.
 *
 * `subscribe()`, `subscribeEdges()` and `subscribeAll()` return
 * `AsyncGenerator`s over the emitter's listeners. When the consumer is done — SSE client
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
 * the life of the process.
 */
/**
 * Whether an event's item type answers a `?type=` subscription filter.
 *
 * Resolved by `typeAnswersSubtreeFilter`, which is the same rule `/items`,
 * `/search` and `/export` compile into SQL for this parameter: the global
 * wildcard, the named type and everything under its name, and the types
 * that declare their way there. Deferring to it rather than restating it
 * is the whole point: a walk of its own would answer a narrower question
 * than every other surface reading the same parameter, with an empty
 * stream and a 200 rather than with an error.
 *
 * **What resolving the registry per live event costs, and what that was
 * judged against.** The yardstick is `matchesTypeFilter`, the permission
 * projection the stream already applies to every item event on the line
 * above this one: nothing costing a fraction of a call this path is
 * already making per event needs a cache in front of it. Measured over
 * two million calls against an instance holding twenty custom types, one of
 * them declaring a shipped parent from outside its namespace:
 *
 *   - name clause answers (`core.media` / `core.media.song`)     ~18ns
 *   - registry walk, declared parent through the registry        ~38ns
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
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string")
    return typeAnswersSubtreeFilter(eventType, filter);
  if (filter.length === 0) return true;
  return filter.some((entry) => typeAnswersSubtreeFilter(eventType, entry));
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

/** Subscribe to edge lifecycle events. There is no typeFilter since edges
 *  don't carry a content type.
 *  Same iterator cleanup contract as `subscribe()` above. */
export async function* subscribeEdges(options?: {
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

/** A frame of either kind, as one subscription hands them on. */
export type LiveFrame =
  | { kind: "item"; event: ItemEventWithId }
  | { kind: "edge"; event: EdgeEventWithId };

/**
 * Both kinds of event in one sequence, in the order they were published,
 * which is the order of their ids, handed on as batches: each take is
 * every frame queued since the last one, so a consumer that has to ask
 * something before delivering (the stream re-reads its credential) asks it
 * once per batch, and every frame in the batch was published before the
 * question was asked.
 *
 * One generator per kind cannot keep that order: each hands its next event
 * on through its own chain of promise jobs, so a burst of item events
 * queued on one side is still being consumed while an edge published after
 * them is handed on by the other, and a subscriber sees a higher id before
 * a lower one. A subscriber that keeps the last id it received as its
 * cursor, which is what the stream tells it to do, then resumes past the
 * lower one for good. One queue fed by both listeners keeps the order the
 * emitter saw.
 *
 * Same cleanup contract as `subscribe()`, with the same limit: closing the
 * iterator takes both listeners off once the generator resumes, which for
 * one parked on a quiet bus is when the next event arrives; a signal takes
 * them off the moment it aborts. The route hands one over.
 */
export async function* subscribeAll(
  options?: SubscribeOptions,
): AsyncGenerator<LiveFrame[]> {
  const queue: LiveFrame[] = [];
  let wake: (() => void) | undefined;
  let ended = options?.signal?.aborted === true;
  const push = (frame: LiveFrame): void => {
    queue.push(frame);
    wake?.();
  };
  const onItem = (event: ItemEventWithId): void => {
    if (eventMatchesTypeFilter(event.item.type, options?.typeFilter)) {
      push({ kind: "item", event });
    }
  };
  const onEdge = (event: EdgeEventWithId): void => {
    push({ kind: "edge", event });
  };
  const onAbort = (): void => {
    ended = true;
    wake?.();
  };
  emitter.on("ITEM_CHANGED", onItem);
  emitter.on("EDGE_CHANGED", onEdge);
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (ended) return;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      yield queue.splice(0);
    }
  } finally {
    emitter.off("ITEM_CHANGED", onItem);
    emitter.off("EDGE_CHANGED", onEdge);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

export { isEdgeEvent };
