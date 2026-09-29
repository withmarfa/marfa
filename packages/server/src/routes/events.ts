import { Hono } from "hono";
import {
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  MarfaError,
  isValidTypePattern,
  matchesTypeFilter,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { requireAuth, getTypeFilter, mayReadType } from "../middleware/auth.js";
import {
  eventMatchesTypeFilter,
  frameFor,
  storedFrame,
  subscribeAll,
  wireEventName,
} from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId, LiveFrame } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { ApiKey, Edge, Metadata } from "@withmarfa/shared";
import { filterMetadataForCaller } from "./util.js";
import {
  edgeKindReadable,
  edgeReadable,
  sourceTypeReadable,
  sourceTypesFor,
} from "./_edge-visibility.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * The longest a replay goes without writing before it says it is still
 * reading. A catch-up ends on a few seconds of silence, and a replay over
 * rows the filter or the credential withholds sends nothing while it reads
 * them, so without this a long one looks like a stream that has finished.
 */
const REPLAY_PROGRESS_MS = 1_000;

/**
 * How long the announcement waits for the log head before giving up on it.
 *
 * Five seconds: how long stream setup tolerates a database that is not
 * answering, sized to ride out a burst of stream turnover without leaving
 * a client hanging.
 *
 * A bound is needed because every connection withholds live delivery from
 * its first moment so the announcement can be the first frame, and the
 * frames it withholds accumulate with no ceiling while the head read is
 * out. The replay's own wait is bounded by its batches; this read is the
 * one way a saturated app pool could leave a viewer counted, subscribed,
 * and buffering forever.
 *
 * **What it degrades to is the point.** Announcing nothing and releasing
 * the hold leaves the client connected, live, and holding no cursor of
 * its own, which is a state its reconnect path handles: it reads the
 * marker that ends the prologue, whose cursor is then whatever the
 * replay or the drained frames reached, or null. A client whose frames
 * are held indefinitely is in no state at all.
 */
const HEAD_READ_TIMEOUT_MS = 5_000;

/**
 * What a head read that outran its budget resolves to.
 *
 * A distinct sentinel rather than `null`, which the read uses for an empty
 * log and the announcement reports as cursor `0` — a real answer that a
 * replay accepts. Collapsing the two would announce the start of the log
 * to a client whose read merely timed out.
 */
const HEAD_READ_TIMED_OUT = Symbol("head-read-timed-out");

/**
 * The wire name of the frame announcing where the stream is.
 *
 * Not an event that happened, which is why it carries no `id:` field: SSE
 * clients treat `id:` as the cursor to resume from, so an announcement
 * carrying one would move a reconnecting client's cursor to the head of
 * the log before a single replayed event had been applied, discarding
 * exactly the backlog the reconnect existed to fetch.
 */
const STREAM_CURSOR_EVENT = "stream_cursor";

/**
 * The frame that says the prologue is over: everything up to the cursor
 * it carries has been sent or withheld, and what follows is live.
 *
 * A subscriber cannot otherwise tell. A frame the filter or the
 * permission projection withholds is not written at all, so the frame
 * that would show the announced head reached can be one this subscriber
 * is never sent, and a reader waiting for it waits for good. Carrying no
 * `id:`, so a client keeping the last id it received is not moved by it;
 * carrying a cursor at or past the announced head, so a client may adopt
 * it and resume past the events it was not sent.
 */
const STREAM_LIVE_EVENT = "stream_live";

/**
 * Most types one `?type=` may name.
 *
 * Ten, the same as the edge-type filter on `GET /edges`, and the same
 * number deliberately: a client filtering a stream and a client filtering
 * a listing are the same client, and a limit it has to look up twice is
 * one it will get wrong once.
 */
const MAX_TYPE_FILTER_ENTRIES = 10;

/**
 * What `?edges=` may say, and what it means when it says nothing.
 *
 * `all` is the default because an edge is the half of a change a
 * reconciling client cannot reconstruct from items alone: it has no row
 * of its own to re-read and no record when it goes. A type filter used
 * to silence every edge event, so a client watching two types never
 * learned about the edges joining them.
 *
 * A value outside this set is refused rather than ignored. An unknown
 * query parameter is dropped silently everywhere else here, which for
 * this one would open a stream carrying everything while the caller
 * believed it had opted out — the client cannot see the difference, and
 * that is precisely the failure this parameter exists to remove.
 */
const EDGE_MODES = ["all", "none"] as const;
type EdgeMode = (typeof EDGE_MODES)[number];
/**
 * How many replayed ids one catch-up remembers, so a live event already
 * on its way to this client is not also sent by the replay.
 *
 * **Derived, and not a function of the backlog.** An id can be delivered
 * twice only if the replay sent it AND the live subscription buffered
 * it, and an event is buffered only when it was emitted after this
 * connection subscribed. The ids at risk are therefore exactly those
 * published while the replay was running, and they always sit at the top
 * of the replayed range. The replay walks that range one
 * `REPLAY_BATCH_SIZE` at a time and already holds a batch of rows in
 * memory, so remembering one batch of ids covers every collision unless
 * more than that many events both committed during the replay and were
 * read by it — and it costs the same order as the read it accompanies.
 *
 * A hundred thousand replayed rows still cost five hundred remembered
 * ids: the backlog is not what this window measures, so raising it buys
 * nothing against a long one. Lowering it starts re-sending events a
 * fast writer produced mid-catch-up.
 *
 * Sufficient, precisely, whenever fewer than a batch of further rows are
 * sent after a buffered event's id is recorded. Past that boundary the
 * guarantee degrades to a second copy rather than to a drop, which is
 * what lets the number be a judgment instead of a proof.
 */
const REPLAY_DEDUPE_WINDOW = REPLAY_BATCH_SIZE;

/**
 * The wire name of the frame saying the stream stopped delivering.
 *
 * A stream that cannot deliver what it promised says so and closes. It
 * never carries on in a state the client cannot observe — a truncated
 * catch-up presented as a complete one, a backlog quietly shortened, half
 * the event kinds silently stopped — because a client has no way to
 * notice any of those and every one of them ends with a cursor sitting
 * past events it never saw.
 *
 * **Carries no `id:` field, and that is the whole recovery.** Nothing
 * after the gap is ever sent, so the last `id:` the client received is
 * still the last event it actually holds, and everything past it is still
 * in the log. Reconnecting with that cursor replays the gap. An `id:` here
 * would move the cursor onto a frame that is not an event and, worse,
 * would move it over the very rows the reconnect exists to fetch.
 *
 * Distinct from `catchup_too_old`, which means the opposite thing about
 * the same cursor: there the log can no longer serve it and the client
 * has to re-read state from the API. Here the cursor is good and the
 * cheap recovery is the correct one, so collapsing the two would send
 * clients on a full re-import after a transient failure.
 */
const STREAM_INCOMPLETE_EVENT = "stream_incomplete";

/**
 * Why the stream stopped. One frame with a reason rather than a frame per
 * cause: the client's recovery is the same in every case — reconnect from
 * the cursor it already holds — so a client learns one frame, and an
 * operator still reads which of four things happened.
 */
type StreamIncompleteReason =
  /** The `Last-Event-ID` catch-up threw partway through. */
  | "replay_failed"
  /** Live frames held during the prologue outgrew {@link MAX_HELD_FRAMES},
   *  or a replay reached a row it cannot read whose live copy it had taken
   *  over from the hold. */
  | "backlog_overflow"
  /** The subscription failed for a reason that was not the client leaving. */
  | "live_delivery_failed"
  /** An edge frame could not be sent: the read that decides whether the
   *  subscriber may see it failed. */
  | "edge_delivery_failed";

/**
 * Most live frames one connection holds while its prologue runs.
 *
 * **A memory bound, held to the dedupe window.** The hold lasts only as
 * long as the prologue, one head read plus a replay when the client sent
 * a cursor, and the buffer grows as the product of the instance's write
 * rate and that duration. The prologue does not get faster because the
 * buffer got bigger, so past some size holding more only defers the same
 * answer at a higher cost. The job of the number is to sit above what an
 * ordinary prologue on a busy instance reaches and below what would
 * matter if a pathological one did not stop.
 *
 * It is no larger than `REPLAY_DEDUPE_WINDOW`, and that is a constraint
 * rather than a coincidence. A held frame was published after the
 * subscription attached, so every row the replay sends after it was
 * published after it too and is held beside it; while the hold is under
 * the cap, fewer rows than the window have been sent past any held frame,
 * so the frame's id is still inside the window when the release asks
 * whether the replay already sent it. A cap above the window would let
 * the window move past a held frame, and the release would send that
 * frame a second time. `releaseHold` relies on this.
 *
 * **What it costs at the boundary, stated because it is a real cost.**
 * `REPLAY_DEDUPE_WINDOW` degrades gracefully at its own edge: past it a
 * client receives a second copy carrying an id it already absorbed. This
 * one does not degrade: at the cap the stream terminates where nothing
 * worse than a duplicate would otherwise have happened, unless a replay is
 * reading, which takes the held frames over (`holdFrame` says how). That is the
 * deliberate trade, a bounded, announced, resumable termination in place
 * of a buffer with no ceiling, and it is worth knowing it is a trade.
 *
 * **What it costs per holding viewer.** A held frame is a two-field
 * wrapper around the event object the emitter broadcast, the same object
 * every other subscriber received rather than a copy, so the marginal
 * cost is the wrappers, and the retained cost is keeping up to this many
 * already-published events alive until the prologue ends. The viewer
 * ceiling bounds how many connections can be holding at once; this bounds
 * the frames each one accumulates. A replay that takes the hold over keeps
 * only the ids of what it took, until it reads past them.
 */
const MAX_HELD_FRAMES = REPLAY_DEDUPE_WINDOW;

/** A live frame published while the stream was still holding delivery. */
type HeldFrame = LiveFrame;

export interface EventRoutesOptions {
  /** Override for the head-read budget; tests drive the degraded path —
   *  no announcement, hold released — with a short one. Default is
   *  `HEAD_READ_TIMEOUT_MS`. */
  headReadTimeoutMs?: number;
  /**
   * Ceiling on concurrent viewers per route instance — one per server
   * process in production, where the app is built once. `0` = uncapped (the
   * default). A deliberate memory bound, not a pool artifact: a viewer
   * holds no database connection, so the cap exists for deployments that
   * want a stated limit rather than discovering one.
   */
  maxViewers?: number;
}

/**
 * Shared by the live path and the replay, so a frame reads the same either
 * way: marks and metadata both narrowed to what this subscriber may read.
 */
function itemFrameFor(stored: Record<string, unknown>, apiKey: ApiKey): string {
  const frame = frameFor(stored, (type) => mayReadType(apiKey, type));
  // Shape-checked: `filterMetadataForCaller` iterates `.extensions`, and a
  // throw here would end a replay short of events the client never re-asks for.
  const metadata: unknown = frame.metadata;
  if (metadata === null || typeof metadata !== "object") {
    return JSON.stringify(frame);
  }
  const extensions: unknown = (metadata as Record<string, unknown>).extensions;
  if (extensions === null || typeof extensions !== "object") {
    return JSON.stringify(frame);
  }
  return JSON.stringify({
    ...frame,
    metadata: filterMetadataForCaller(metadata as Metadata, apiKey),
  });
}

/**
 * Read `?type=` as one type or several.
 *
 * Returned as an array in both cases so the two delivery paths cannot
 * take different shapes from the same parameter. `undefined` means no
 * filter; a value that trims to nothing is that rather than a filter
 * admitting nothing, so `?type=` and `?type=,` open an unfiltered stream
 * instead of a silent, permanent one.
 *
 * **Each entry is held to the grammar `/items`, `/search` and `/export`
 * hold this parameter to, and refused on the same terms.** A stream that
 * accepted any string and then matched nothing with it would give the
 * worst answer a filter can give: a 200 and an empty stream, which a
 * client cannot tell from a quiet instance. A spelling the list surfaces
 * reject reaches the caller as the rejection they already get there
 * rather than as silence.
 *
 * The global wildcard is refused for the reason it is refused on those
 * surfaces rather than because it is hard to honor: "everything" is this
 * stream with no `type` at all, and a filter matching every type would
 * slip past the per-type levers keyed off this parameter.
 */
function parseTypeFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length > MAX_TYPE_FILTER_ENTRIES) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Too many types in filter (max ${String(MAX_TYPE_FILTER_ENTRIES)})`,
    );
  }
  for (const part of parts) {
    if (part === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(part)) {
      throw malformedTypeIdentifier("type", `Invalid type identifier: ${part}`);
    }
  }
  return parts;
}

/**
 * The edge inside a stored event payload, or null if the row cannot be
 * read as one.
 *
 * Null rather than a throw, and the caller withholds the row and names it
 * in the log: a stored string's declared shape is a claim about it rather
 * than a fact, and a row that cannot be measured against the permission
 * maps cannot be proved readable by anyone. The item path logs its own
 * undecodable rows for the same reason — a payload that does not decode
 * is a defect somebody has to find, and a silent skip leaves no trace of
 * it anywhere.
 */
function decodeStoredEdge(payload: string): Edge | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const edge: unknown = (parsed as { edge?: unknown }).edge;
  if (typeof edge !== "object" || edge === null) return null;
  const { edge_type: kind, source_id: source } = edge as {
    edge_type?: unknown;
    source_id?: unknown;
  };
  if (typeof kind !== "string" || typeof source !== "string") return null;
  return edge as Edge;
}

function parseEdgeMode(raw: string | undefined): EdgeMode {
  if (raw === undefined) return "all";
  const found = EDGE_MODES.find((mode) => mode === raw);
  if (found === undefined) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown edges value ${JSON.stringify(raw)} (expected ${EDGE_MODES.join(" or ")})`,
    );
  }
  return found;
}

export function eventRoutes(
  storage: Storage,
  options: EventRoutesOptions = {},
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  let liveViewers = 0;

  // GET /events — Server-Sent Events stream with replay support
  router.get("/", (c) => {
    const apiKey = requireAuth(c);
    const typeParam = parseTypeFilter(c.req.query("type"));
    const edgeMode = parseEdgeMode(c.req.query("edges"));
    const lastEventId = c.req.header("Last-Event-ID");
    // The SSE stream is the one type filter with no query to hang a
    // predicate on, so it asks `matchesTypeFilter` — written over the same
    // ranking the SQL compilers use, so a streamed answer and a queried one
    // cannot disagree about the same grant.
    const typeFilter = getTypeFilter(c);

    return (() => {
      const maxViewers = options.maxViewers ?? 0;
      if (maxViewers > 0 && liveViewers >= maxViewers) {
        throw new MarfaError(
          ErrorCode.STREAM_CAPACITY_EXHAUSTED,
          "This instance is serving its maximum number of live-update viewers; retry shortly",
          { reason: "viewer_cap" },
        );
      }
      // Counted atomically with the check above — an await between them
      // would let a reconnect burst admit far more than the cap while
      // every request still saw room. Everything below that can throw is
      // bracketed so a failed setup never strands the count.
      liveViewers += 1;

      try {
        // event_log.id is an INTEGER rowid — parse as BigInt so cursors
        // above Number.MAX_SAFE_INTEGER round-trip cleanly.
        let afterId: bigint | null = null;
        if (lastEventId) {
          try {
            afterId = BigInt(lastEventId);
          } catch {
            afterId = null;
          }
        }

        return buildStream(afterId);
      } catch (err) {
        // The stream never started, so its cleanup will never run: the
        // slot is this path's to give back.
        liveViewers -= 1;
        throw err;
      }
    })();

    function buildStream(afterId: bigint | null): Response {
      // Set inside start(), fired from cancel(): a consumer that cancels
      // the stream (rather than dropping the connection, which fires the
      // abort signal) must still release the viewer slot.
      let onCancel: (() => void) | null = null;

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Object wrapper prevents TS narrowing from assuming `closed` stays `false` across async closures.
          const state: { closed: boolean } = { closed: false };

          // Aborting detaches the emitter listeners immediately.
          // iterator.return() alone cannot: a generator suspended on an
          // event that never arrives stays suspended, and a quiet instance
          // would retain one listener per departed viewer indefinitely.
          const subscriptionAbort = new AbortController();

          let lastWriteAt = Date.now();
          const send = (data: string) => {
            if (state.closed) return;
            lastWriteAt = Date.now();
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              // Controller gone — cleanup immediately rather than waiting for the next pump tick.
              cleanup();
            }
          };

          // Keep-alive pings
          const keepAlive = setInterval(() => {
            send(":ping\n\n");
          }, KEEPALIVE_INTERVAL_MS);

          // Declared before the first send: send's catch calls cleanup,
          // and an arrow binding would still be in its temporal dead
          // zone on the very first write.
          const cleanup = () => {
            if (state.closed) return;
            state.closed = true;
            liveViewers -= 1;
            clearInterval(keepAlive);
            subscriptionAbort.abort();
          };

          // Flush response headers immediately so reverse proxies that buffer
          // SSE bodies (notably Cloudflare Tunnel) deliver the 200 + content-type
          // to the client without waiting for the first event or the 30s
          // keep-alive ping. SSE comments are ignored by EventSource parsers.
          send(": connected\n\n");

          /**
           * One buffer for both kinds, in the order they were published.
           *
           * Two buffers drained one after the other reorder the stream:
           * every held edge arrives after every held item, whatever the
           * writer did, so a client reconciling a graph learns about an
           * edge before or after the items it joins depending on nothing
           * it can observe. One buffer also removes the second site the
           * suppression rule below would have to be written at.
           */
          const heldFrames: HeldFrame[] = [];
          /**
           * Live delivery is held until the prologue has announced the
           * cursor and, when the client sent one, finished replaying from
           * it.
           *
           * Held from the first moment rather than only for a replay: the
           * announcement has to be the stream's first frame, and reading
           * the log head is a round trip an event published meanwhile
           * would otherwise overtake.
           */
          let holding = true;
          /**
           * Ids this connection's replay actually sent, so a live event
           * already on its way to this client is not delivered twice.
           *
           * Empty when there is no replay, which suppresses nothing —
           * exactly right, since nothing has been sent to duplicate.
           */
          const replayedIds = new Set<bigint>();
          /**
           * The last `id:` this stream wrote, which is the cursor the
           * client is holding.
           *
           * Recorded because it is what a failure has to hand back: every
           * termination below stops without sending anything past the
           * gap, so this stays a faithful resume point and the frame that
           * announces the failure can say so. Advanced only where an
           * `id:` is actually written — a frame the filter withheld moved
           * no client cursor.
           *
           * The log issues ids in commit order and this stream sends
           * frames in that order, edge frames beside item frames, so the
           * last id written is the highest and a reader resuming from it
           * misses nothing. The one exception is a stored row the replay
           * could not decode, whose live copy goes out after the replay
           * under its lower id (`events-replay-dedupe.test.ts`): then
           * this is that lower id, and a reader resuming from it repeats
           * the replayed frames above it and still misses nothing.
           * `events-live-order.test.ts` holds the stream to the order and
           * `sync/resume.test.ts` a resuming reader.
           */
          let lastSentId: bigint | null = null;
          /**
           * The highest id the replay read, withheld rows included, and
           * null where it read none: what the marker that ends the
           * prologue names beside the head and the last id written, since
           * a reader may resume past everything the replay covered whether
           * or not it was sent it. Never the cursor the client arrived
           * with, which may sit past the head and would then be named back
           * to it as a position the stream had reached.
           */
          let replayedTo: bigint | null = null;

          // Subscribed before the replay starts, so nothing falls between
          // the two. One subscription for both kinds of frame, in publish
          // order: a frame sent ahead of a lower id would move a
          // subscriber's cursor past an event it never saw.
          const frames = subscribeAll({
            typeFilter: typeParam,
            signal: subscriptionAbort.signal,
          })[Symbol.asyncIterator]();

          /**
           * Whether an item frame survives the caller's type projection.
           *
           * Named because it is asked twice — once before a frame is
           * held and again when it is released — and those two must be
           * the same question. Both inputs are fixed for the life of the
           * connection: `typeFilter` is computed once at request start
           * and a frame's own type never changes, so an early answer
           * cannot differ from a late one.
           */
          const itemPassesProjection = (event: ItemEventWithId): boolean =>
            matchesTypeFilter(event.item.type, typeFilter);

          /** Whether edge frames reach this stream at all. Read once:
           *  `?edges=` is a request parameter, not a per-frame property. */
          const edgesReachThisStream = edgeMode !== "none";

          const sendEvent = (
            eventId: bigint | undefined,
            event: ItemEventWithId,
          ) => {
            if (!itemPassesProjection(event)) {
              return;
            }

            const wireType = wireEventName(event.type);
            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            if (eventId !== undefined) lastSentId = eventId;
            send(
              `${idField}event: ${wireType}\ndata: ${itemFrameFor(storedFrame(event), apiKey)}\n\n`,
            );
          };

          // Edge events don't carry an item type, so `?type=` says nothing
          // about them: it names the item types this subscriber wants, and
          // an edge is not an item. Silencing them under a type filter
          // would leave a filtered client watching two types and never
          // learning about the edges joining them, which is the half
          // nothing else can reconstruct. `?edges=none` is the opt-out,
          // and it is independent of the type filter.
          //
          // **A subscriber's own parameter is not a permission.** An edge
          // frame discloses both endpoints, the kind of relationship and
          // the properties on it, which `GET /edges/{id}` refuses a
          // credential one at a time; the two questions that door asks
          // are asked here, per subscriber, before the frame is written,
          // through the function the plural doors call.
          //
          // **The lookup is per frame on the live path, and it is a
          // decision rather than the only option.** Live frames arrive one
          // at a time, so there is nothing to batch them with; the
          // alternative considered was a per-subscriber cache of source id
          // to type, bounded and evicting, which saves a read only where
          // consecutive edge frames share a source — the shape of one bulk
          // write rather than of a stream — and buys that with an eviction
          // rule and a staleness argument on a connection that already
          // outlives a key change. So: one keyed read per edge frame per
          // subscriber, paid only after the edge type has passed, which is
          // nothing at all for a subscriber that may not read the kind of
          // relationship. **The replay is the other case and does batch**,
          // because it holds a page of up to `REPLAY_BATCH_SIZE` rows; see
          // `replay` below.
          //
          // Async, which the item path is not, and both call sites wait on
          // it: the prologue's drain stays held for the whole release, and
          // the live pump sends nothing else until it settles, so no frame
          // published after this edge is written ahead of it. Publish
          // order is id order, and a subscriber's cursor is the last id it
          // received.
          const sendEdgeEvent = async (
            eventId: bigint | undefined,
            event: EdgeEventWithId,
          ): Promise<void> => {
            // The cheap half first, and `holdFrame` asks the same
            // question before it holds a frame at all, so a subscriber
            // that reads no edge type neither buffers these nor pays a
            // lookup for them.
            if (!edgesReachThisStream) return;
            if (!edgeKindReadable(apiKey, event.edge)) return;
            if (!(await edgeReadable(storage, apiKey, event.edge))) return;
            const wireType = wireEventName(event.type);
            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            if (eventId !== undefined) lastSentId = eventId;
            send(
              `${idField}event: ${wireType}\ndata: ${JSON.stringify(storedFrame(event))}\n\n`,
            );
          };

          const pump = () => {
            frames
              .next()
              .then(async ({ value: frame, done }) => {
                if (done || state.closed) {
                  // Capture before cleanup flips it, or the close below
                  // could never run and a terminated pump would leave
                  // the client's socket dangling with no data and no
                  // pings until its own timeout.
                  const wasOpen = !state.closed;
                  cleanup();
                  if (wasOpen) {
                    try {
                      controller.close();
                    } catch {
                      /* already closed */
                    }
                  }
                  return;
                }

                if (holding) {
                  holdFrame(frame);
                } else if (frame.kind === "item") {
                  sendEvent(frame.event.eventId, frame.event);
                } else {
                  // Awaited, so the next frame waits behind the source
                  // read this one needs: that wait is what a frame
                  // published after this edge would otherwise overtake. A
                  // failure ends the stream, because a subscriber silently
                  // stopped hearing about relationships is the one shape a
                  // durable client cannot detect.
                  try {
                    await sendEdgeEvent(frame.event.eventId, frame.event);
                  } catch (err: unknown) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state.closed is mutated by the cleanup() callback invoked from outside this callback; TS narrows it to `false` from the check above but at runtime it can flip to true.
                    if (state.closed) return;
                    console.warn(
                      `[events] closing the stream: edge delivery failed (${String(err)})`,
                    );
                    failStream("edge_delivery_failed");
                    return;
                  }
                }
                pump();
              })
              .catch((err: unknown) => {
                // Already closed means the client left and `cleanup` has
                // run: the pending `next()` rejecting with the abort is
                // the subscription ending, not a failure.
                if (state.closed) return;
                console.warn(
                  `[events] closing the stream: live delivery failed (${String(err)})`,
                );
                failStream("live_delivery_failed");
              });
          };

          // The pump runs before the helpers it calls are initialized,
          // which is safe and deliberate: only its `.then`/`.catch`
          // callbacks reach those, and the first of those cannot run
          // until this synchronous body has finished. Starting it here
          // is what attaches the emitter listeners, and moving that later
          // would widen the window in which a publish has nobody
          // listening.
          pump();

          /**
           * End the stream from a terminal decision rather than from a
           * client disconnect: release the viewer slot, detach the
           * emitter listeners, and close the response body.
           */
          const endStream = (): void => {
            const wasOpen = !state.closed;
            cleanup();
            void frames.return(undefined);
            if (wasOpen) {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          };

          /**
           * Stop delivering, say so, and close.
           *
           * The one exit every "this stream can no longer honor what it
           * opened with" path takes, so the four causes cannot drift into
           * four different behaviors: a failure that ended the
           * connection, one that ended half of it silently and one that
           * carried on as though nothing had happened would each leave a
           * client unable to tell which it had met.
           *
           * The held frames go unsent, and that is the point rather than
           * a side effect: they sit after the gap, so delivering them
           * would present an incomplete stream as a complete one and
           * carry the client's cursor past events it never received.
           */
          const failStream = (reason: StreamIncompleteReason): void => {
            const payload = JSON.stringify({
              type: STREAM_INCOMPLETE_EVENT,
              reason,
              // What to reconnect with. Null when this stream had not
              // delivered an event yet, which a client reads as "resume
              // from whatever you already had".
              cursor: lastSentId === null ? null : String(lastSentId),
            });
            send(`event: ${STREAM_INCOMPLETE_EVENT}\ndata: ${payload}\n\n`);
            heldFrames.length = 0;
            endStream();
          };

          // While a replay reads, the id it reads on to at least; the ids
          // of the held frames given up to it that it has not yet passed;
          // and the rows it has passed but could not read, whose live copy
          // is their one carrier (`events.md` 3).
          let replayReach: bigint | null = null;
          const givenUp = new Set<bigint>();
          const unreadable = new Set<bigint>();

          /**
           * Hold one live frame until the prologue is done with it.
           *
           * The cap is enforced here, beside the buffer it bounds, so a
           * frame of either kind meets the one rule.
           *
           * **A frame that will not be delivered is not held, and this is
           * the load-bearing half.** A cap that counted frames the
           * release path is guaranteed to discard would let traffic a
           * subscriber had explicitly excluded exhaust its buffer and
           * terminate its stream: `?edges=none` killed by edge events,
           * and a credential scoped to one type by events of another, or
           * one holding no edge type at all by edges of every kind.
           * Narrowing the subscription would then make it worse rather
           * than better, which is the opposite of what a filter is for,
           * and a subscriber that wants items only asks for exactly that
           * configuration. Each question is one the release path asks,
           * asked here through the same predicate so they cannot drift,
           * and each is stable for the life of the connection so asking
           * early cannot answer differently.
           *
           * **The edge frame's source-type half is the one question the
           * release path asks and this does not**, and deliberately: it
           * is a keyed read, and paying it per frame on the way into a
           * buffer that may never be drained would put a round trip on
           * the prologue for every frame a slow start accumulates. So a
           * subscriber holding the edge type but not the source's can
           * still fill this buffer with frames the release path will
           * drop. What is asked here is the half that empties the buffer
           * for the subscriber most likely to fill it: the one holding
           * no edge type at all.
           *
           * The projection costs a `matchesTypeFilter` per held frame it
           * admits, paid again when that frame is released. Bounded by
           * this cap and measured at ~146ns, that is at most ~73us across
           * a whole connection's prologue — against a buffer that could
           * otherwise be filled entirely by frames its owner cannot
           * receive.
           *
           * The `?type=` filter is not asked here because it is applied
           * upstream, inside the subscription, so a frame it excludes
           * never reaches this function.
           * The replay dedupe is the one release-time drop that stays at
           * release: whether a held id was also sent by the replay is not
           * knowable until the replay has finished, so the cap can still
           * count a frame that turns out to be a duplicate.
           *
           * Overflow ends the stream rather than shedding frames. Dropping
           * the oldest or the newest would be a silent truncation, which
           * is the failure this whole file is arranged against; carrying
           * on live would interleave held frames with replayed ones and
           * reorder the stream. Ending it leaves everything unsent still
           * in the log, behind a cursor the client already holds.
           *
           * **But not while a replay reads.** Every held frame is a row of
           * the log below the frame arriving, so the held frames are given
           * up to the replay, which reads on past the newest of them and
           * sends each itself. That is no truncation, and without it a
           * replay long enough to let writers in fills the hold behind it
           * on any busy instance. A row the replay cannot read is the one
           * exception: its live copy is all it has, so where that copy was
           * given up the stream ends as it would have.
           */
          const holdFrame = (frame: HeldFrame): void => {
            const deliverable =
              frame.kind === "edge"
                ? edgesReachThisStream &&
                  edgeKindReadable(apiKey, frame.event.edge)
                : itemPassesProjection(frame.event);
            if (!deliverable) return;
            if (heldFrames.length >= MAX_HELD_FRAMES && replayReach !== null) {
              const ids: bigint[] = [];
              for (const held of [...heldFrames, frame]) {
                if (held.event.eventId === undefined) break;
                ids.push(held.event.eventId);
              }
              const newest = frame.event.eventId;
              if (
                newest !== undefined &&
                ids.length === heldFrames.length + 1 &&
                !ids.some((id) => unreadable.has(id))
              ) {
                for (const id of ids) givenUp.add(id);
                if (newest > replayReach) replayReach = newest;
                heldFrames.length = 0;
                return;
              }
            }
            if (heldFrames.length >= MAX_HELD_FRAMES) {
              console.warn(
                `[events] closing the stream: ${String(MAX_HELD_FRAMES)} live frames accumulated while it was still opening, and the prologue has not finished`,
              );
              failStream("backlog_overflow");
              return;
            }
            heldFrames.push(frame);
          };

          /**
           * Send what the client missed, and answer whether it got all of
           * it. A false answer means the stream has already been told and
           * closed, so the caller must not release the hold on top of it.
           */
          const replay = async (afterIdResolved: bigint): Promise<boolean> => {
            // Above the `try` because the catch reports it: a catch-up
            // that stopped is only actionable if it says where.
            let lastReplayedId: bigint = afterIdResolved;
            // The last row read, as against where the read started: the
            // position the marker may name.
            let lastRead: bigint | null = null;
            replayReach = afterIdResolved;
            const liveCopyGivenUp = (id: bigint): boolean => {
              unreadable.add(id);
              if (!givenUp.has(id)) return false;
              console.warn(
                `[events] closing the stream: event ${String(id)} cannot be read from the log and its live copy was given up with the hold`,
              );
              failStream("backlog_overflow");
              return true;
            };
            try {
              // A cursor is too old when the log no longer holds the event
              // after it: the oldest retained id is greater than the cursor
              // plus one. Then the copy behind that cursor cannot be caught
              // up from the log, so the stream answers a terminal
              // `catchup_too_old` and closes, and the client hydrates again.
              //
              // Plus one, because a cursor names the last event a client
              // applied, not the first one it wants. Without it a cursor of
              // `0` on a log whose first event is `1` is refused, and that
              // is a client that has missed nothing: it is every device
              // that hydrated an instance with an empty log. A log with no
              // events never trips the check.
              const retiredAfter = async (after: bigint): Promise<boolean> => {
                const minRetained = await storage.eventLog.getMinRetainedId();
                if (minRetained === null || after + 1n >= minRetained) {
                  return false;
                }
                const payload = JSON.stringify({
                  type: "catchup_too_old",
                  min_retained_id: String(minRetained),
                  requested: String(afterIdResolved),
                });
                // id is the min retained id so clients don't store a cursor older than the log can serve.
                send(
                  `id: ${String(minRetained)}\nevent: catchup_too_old\ndata: ${payload}\n\n`,
                );
                endStream();
                return true;
              };
              if (await retiredAfter(afterIdResolved)) return false;

              // What is safe to discard is an id this replay actually
              // sent, so that is what is recorded rather than the
              // cursor, which advances past every row this loop walks,
              // rows a filter withheld included. A row the log holds but
              // cannot serve, one whose payload does not decode, is not
              // recorded either: its live copy is the one carrier that
              // event has left, and it goes out after the replay, behind
              // the ids replayed above it, which `events.md` 3 names as the
              // one exception to the order. Recorded into a set
              // that belongs to the stream rather than to this function,
              // because the drain it feeds runs whether or not there was
              // a replay to feed it.
              //
              // Insertion order, for eviction. Replayed ids arrive
              // ascending, so the front is always the oldest.
              const replayedOrder: bigint[] = [];
              const rememberReplayed = (id: bigint): void => {
                replayedIds.add(id);
                replayedOrder.push(id);
                if (replayedOrder.length > REPLAY_DEDUPE_WINDOW) {
                  const evicted = replayedOrder.shift();
                  if (evicted !== undefined) replayedIds.delete(evicted);
                }
              };
              while (!state.closed) {
                const batch = await storage.eventLog.getAfter(
                  lastReplayedId,
                  REPLAY_BATCH_SIZE,
                );

                if (batch.length === 0) {
                  if (lastReplayedId >= replayReach) break;
                  // Frames given up while this read was out are past what
                  // it saw, so it reads again for them.
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  continue;
                }

                // The sweep can run between the check above and any read
                // here. A batch that does not start at the next id may
                // have lost the events before it to the sweep, and only
                // the oldest retained id, read after the batch, tells.
                const [first] = batch;
                if (
                  first !== undefined &&
                  first.id !== lastReplayedId + 1n &&
                  (await retiredAfter(lastReplayedId))
                ) {
                  return false;
                }
                if (Date.now() - lastWriteAt >= REPLAY_PROGRESS_MS) {
                  send(": replaying\n\n");
                }

                // The batch's edge rows, decoded once and their source
                // items read in one query.
                //
                // **The replay is the half that can batch, and it has
                // to.** A page here is up to `REPLAY_BATCH_SIZE` rows
                // and a catch-up walks page after page with no cap of
                // its own, so a source read per edge row would be that
                // many serial round trips, on the one path with no
                // `limit` to bound it. The live pump is the other half and cannot
                // batch, because it holds one frame; `sendEdgeEvent`
                // says so there.
                //
                // The decode is kept rather than repeated below, so an
                // edge payload is parsed once whichever question reads
                // it.
                const replayEdges = new Map<bigint, Edge>();
                for (const row of batch) {
                  if (row.edge_id === null || edgeMode === "none") continue;
                  const edge = decodeStoredEdge(row.payload);
                  if (edge) {
                    replayEdges.set(row.id, edge);
                  } else {
                    console.warn(
                      `[events] replay skipped event ${String(row.id)}: stored edge payload is not valid JSON`,
                    );
                  }
                }
                const replaySourceTypes = await sourceTypesFor(
                  storage,
                  [...replayEdges.values()].map((edge) => edge.source_id),
                );

                for (const event of batch) {
                  // False rather than true: the client is gone, so this
                  // catch-up did not finish and there is nobody to
                  // release a hold for.
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state.closed is mutated by the cleanup() callback invoked from outside this loop; TS narrows it to `false` from the enclosing while-check but at runtime it can flip to true.
                  if (state.closed) return false;
                  const isEdge = event.edge_id !== null;
                  // The same rule the live path applies, and the
                  // reason it is written as one: an edge carries no
                  // item type, so `?type=` has nothing to say about
                  // it, and only `?edges=none` withholds it.
                  if (isEdge && edgeMode === "none") {
                    lastReplayedId = event.id;
                    lastRead = event.id;
                    continue;
                  }
                  let parsed: Record<string, unknown> | null = null;
                  if (!isEdge) {
                    try {
                      parsed = JSON.parse(event.payload) as Record<
                        string,
                        unknown
                      >;
                    } catch {
                      // Fail closed on a stored payload that is not
                      // JSON. It cannot be narrowed to what this
                      // subscriber may read, so sending it would hand
                      // over whatever it holds regardless of the
                      // permissions this whole path exists to apply;
                      // and it would not decode on the client either,
                      // so withholding it costs nothing usable. One
                      // line names the row, because a payload that is
                      // not JSON is a defect somebody has to find, and
                      // a silent skip leaves no trace of it anywhere.
                      console.warn(
                        `[events] replay skipped event ${String(event.id)}: stored payload is not valid JSON`,
                      );
                      if (liveCopyGivenUp(event.id)) return false;
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                  }
                  // Everything that classifies an item row lives inside
                  // this branch, and `parsed !== null` is exactly the
                  // condition under which it was decoded — an edge row
                  // never reaches it and is never asked to name a type
                  // it does not carry. Its own gate is below.
                  //
                  // **One decision about a row that cannot be
                  // classified, rather than two checks reaching
                  // opposite conclusions about it.** The type filter
                  // and the permission narrowing immediately after it
                  // read the same value, so splitting the decision
                  // between them lets one withhold the row while the
                  // other, guarding on that value being present, hands
                  // it over unnarrowed — and the one that fails open
                  // that way is the permission check. Nothing in the
                  // tree writes that payload today — the publisher
                  // always attaches the item — but that is a property
                  // of the current writers rather than of this code,
                  // and it is not one a permission check should be
                  // resting on.
                  //
                  // Withheld rather than sent, because a row whose type
                  // cannot be read cannot be proved readable by this
                  // subscriber, and a filter that cannot classify a row
                  // has no business handing it over.
                  if (parsed !== null) {
                    const parsedItem: unknown = parsed.item;
                    const named: unknown =
                      typeof parsedItem === "object" && parsedItem !== null
                        ? (parsedItem as { type?: unknown }).type
                        : undefined;
                    if (typeof named !== "string") {
                      if (liveCopyGivenUp(event.id)) return false;
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                    // The same function the live path filters on, and
                    // called here rather than reimplemented: `?type=`
                    // names a subtree, so a string comparison drops a
                    // subtype the live stream delivers, and the client
                    // has no way to see that its view narrowed on
                    // reconnect. Passed the arguments live passes, so the
                    // two cannot resolve the same filter differently.
                    if (
                      typeParam !== undefined &&
                      !eventMatchesTypeFilter(named, typeParam)
                    ) {
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                    if (
                      typeFilter.allowed !== undefined &&
                      !matchesTypeFilter(named, typeFilter)
                    ) {
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                  }

                  // The edge row's own gate: the pair the live path
                  // applies, applied to the stored edge. A replayed
                  // frame is the same disclosure as a live one, reached
                  // through a cursor instead of a subscription, so a
                  // catch-up that skipped this would hand back
                  // everything the live stream withholds.
                  //
                  // Withheld where the payload cannot be read as an
                  // edge, for the reason an unclassifiable item row is
                  // withheld: a row that cannot be measured against the
                  // maps cannot be proved readable, and a filter that
                  // cannot classify a row has no business handing it
                  // over.
                  if (isEdge) {
                    const storedEdge = replayEdges.get(event.id);
                    if (storedEdge === undefined) {
                      if (liveCopyGivenUp(event.id)) return false;
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                    if (
                      !edgeKindReadable(apiKey, storedEdge) ||
                      !sourceTypeReadable(
                        apiKey,
                        replaySourceTypes.get(storedEdge.source_id),
                      )
                    ) {
                      lastReplayedId = event.id;
                      lastRead = event.id;
                      continue;
                    }
                  }

                  const replayWireType = wireEventName(
                    event.event_type as
                      ItemEventWithId["type"] | EdgeEventWithId["type"],
                  );
                  lastSentId = event.id;
                  send(
                    `id: ${String(event.id)}\nevent: ${replayWireType}\ndata: ${parsed === null ? event.payload : itemFrameFor(parsed, apiKey)}\n\n`,
                  );
                  // Only here. A row the loop skipped above was not
                  // sent, so its live copy is not a duplicate.
                  rememberReplayed(event.id);
                  lastReplayedId = event.id;
                  lastRead = event.id;
                }

                // In id order, as given up.
                for (const id of givenUp) {
                  if (id > lastReplayedId) break;
                  givenUp.delete(id);
                }
                if (
                  batch.length < REPLAY_BATCH_SIZE &&
                  lastReplayedId >= replayReach
                ) {
                  break;
                }
                // The log's reads are synchronous under their promises, so
                // a replay that never yields holds the process: nothing it
                // wrote reaches the wire, and no other request is answered,
                // until the last batch.
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
              replayedTo = lastRead;
              return true;
            } catch (err) {
              // A catch-up that failed leaves the client short of events
              // it will never ask for again. Ending the stream is what
              // makes that visible: a connection that cleared its
              // buffers and carried on would stay open with the
              // announcement saying nothing, and the client could not
              // tell a truncated backlog from a complete one.
              // `isSubtypeOf` throwing on an unresolvable chain is a
              // reachable way in, because this path resolves subtypes,
              // and on the live path the same failure already ends the
              // stream where the client can see it.
              //
              // The cursor is named in the log because it is the only
              // thing that identifies which catch-up stopped and where,
              // and it is the row after it that has to be looked at.
              console.warn(
                `[events] closing the stream: the catch-up could not complete after event ${String(lastReplayedId)} (${String(err)})`,
              );
              failStream("replay_failed");
              return false;
            } finally {
              replayReach = null;
              givenUp.clear();
              unreadable.clear();
            }
          };

          /**
           * Live delivery resumes, oldest held frame first.
           *
           * Withheld against the ids the replay sent, not against the
           * cursor. Two consequences worth naming.
           *
           * A row the replay skipped is not suppressed here, and that
           * discloses nothing: delivery goes through `sendEvent`, whose
           * first act is the same permission narrowing the replay
           * applied, so the held copy meets that filter whatever this
           * decides.
           *
           * An id evicted from the window would be sent a second time
           * carrying the same `id:`, which a client applying a payload by
           * id absorbs; `MAX_HELD_FRAMES` is no larger than the window so
           * that the window cannot move past a held frame, and it does
           * not happen. Dropping an event the client had no way to learn
           * it was missing is the failure this rule exists against.
           *
           * Stops rather than continuing when the stream closed
           * mid-drain, so nothing is written into a controller that is
           * gone.
           */
          const releaseHold = async (): Promise<void> => {
            // **`holding` stays true for the whole drain.** An edge frame
            // awaits a source read, and a live frame arriving across that
            // await would otherwise be sent at once and land in front of
            // held frames that were published before it
            // — reordering the stream, which is the failure the single
            // buffer exists to prevent. Frames that arrive mid-drain are
            // held as usual and this loop keeps going until the buffer is
            // empty, so nothing is stranded.
            //
            // **Taken off the front rather than walked in place**, so the
            // buffer's length is what is still undelivered and nothing
            // else. `MAX_HELD_FRAMES` is measured against that length, and
            // a walk that left the delivered prefix in place would let two
            // frames arriving during one source read push a nearly full
            // buffer past the cap and end a stream whose prologue had
            // already finished — the buffer would be reported as
            // overflowing while it was draining.
            try {
              for (;;) {
                if (state.closed) break;
                const frame = heldFrames.shift();
                if (frame === undefined) break;
                const eventId = frame.event.eventId;
                if (eventId !== undefined && replayedIds.has(eventId)) continue;
                if (frame.kind === "item") sendEvent(eventId, frame.event);
                else await sendEdgeEvent(eventId, frame.event);
              }
            } catch (err) {
              // The source read behind an edge frame failed. The same
              // decision the live pump takes, and it has to be taken here
              // too: this runs inside the prologue, whose rejection
              // nothing else handles.
              if (!state.closed) {
                console.warn(
                  `[events] closing the stream: edge delivery failed while releasing the hold (${String(err)})`,
                );
                failStream("edge_delivery_failed");
              }
              return;
            }
            // The buffer is already empty unless the stream closed
            // mid-drain, in which case what is left goes unsent — the
            // same decision `failStream` takes, and for the same reason.
            // Nothing can be appended between the loop ending and the
            // flag dropping, because no await separates them; and the
            // marker is written in the same breath, before the flag
            // drops, so no live frame can be written ahead of it.
            announceLive();
            holding = false;
            heldFrames.length = 0;
          };

          /** Read the log head this stream announces. */
          const readHeadEventId = (): Promise<bigint | null> =>
            storage.eventLog.getMaxId();

          /**
           * The head read, bounded.
           *
           * The read itself cannot be canceled — a query already waiting
           * on the write lock runs when its turn comes whatever this
           * connection has decided — so the budget governs how long the
           * stream waits for it, not how long it takes. That is why the
           * settled read gets a terminal handler of its own here: once the
           * race is over nothing else is waiting on that promise, and a
           * rejection arriving late with no handler attached takes the
           * process down rather than this one connection.
           */
          const readHeadWithinBudget = (): Promise<
            bigint | null | typeof HEAD_READ_TIMED_OUT
          > => {
            const budgetMs = options.headReadTimeoutMs ?? HEAD_READ_TIMEOUT_MS;
            const read = readHeadEventId();
            read.catch(() => undefined);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const budget = new Promise<typeof HEAD_READ_TIMED_OUT>(
              (resolve) => {
                timer = setTimeout(() => {
                  resolve(HEAD_READ_TIMED_OUT);
                }, budgetMs);
              },
            );
            return Promise.race([read, budget]).finally(() => {
              if (timer !== undefined) clearTimeout(timer);
            });
          };

          /** The head the stream announced, once it has. */
          let announcedHead: bigint | null = null;

          /**
           * Say where the stream is, before it says anything else.
           *
           * The cursor is a position in `event_log.id`, the log's single
           * ascending sequence, and that is what makes it safe to replay
           * under a filter it was not taken under: `?type=` and `?edges=`
           * choose a subset of that sequence and never a different order
           * of it, so a cursor carried across a filter change selects
           * fewer rows or more, and never skips or repeats one. That is
           * the opposite of the listing cursors, where `updated_after`
           * changes the ordering itself and a cursor from one ordering
           * cannot be continued under the other.
           *
           * Answers false when it could not be read, having already
           * closed the stream. A read that merely outran its budget
           * answers true and announces nothing: see below.
           */
          const announceCursor = async (): Promise<boolean> => {
            let head: bigint | null | typeof HEAD_READ_TIMED_OUT;
            try {
              head = await readHeadWithinBudget();
            } catch (err) {
              // A stream that cannot say where it is cannot be resumed
              // from, and a client that reads its snapshot behind one
              // has no way to discover that until it has already lost
              // the events in the gap. Closing hands it back to its own
              // reconnect path, which is the only place it can recover.
              console.warn(
                `[events] closing the stream: the event-log head could not be read (${String(err)})`,
              );
              endStream();
              return false;
            }
            if (head === HEAD_READ_TIMED_OUT) {
              // The opposite decision from the failure above, and for a
              // reason worth stating: a read that has not come back says
              // nothing about whether the log is readable, only that the
              // database is busy. Closing here would turn a slow database
              // into a disconnect for every connecting client at once,
              // and each would reconnect onto the same database. So the
              // stream stays open with no announcement: the caller
              // releases the hold on its way past, and the marker that
              // ends the prologue then names whatever position the
              // replay or the drained frames reached, or none.
              console.warn(
                `[events] announcing no cursor: the event-log head did not arrive within ${String(
                  options.headReadTimeoutMs ?? HEAD_READ_TIMEOUT_MS,
                )}ms`,
              );
              return true;
            }
            // An empty log announces 0, which is a cursor the replay
            // accepts and the retention check passes: `getMinRetainedId`
            // answers null on an empty log, so nothing reads 0 as stale.
            announcedHead = head ?? 0n;
            const payload = JSON.stringify({
              type: STREAM_CURSOR_EVENT,
              cursor: String(announcedHead),
            });
            send(`event: ${STREAM_CURSOR_EVENT}\ndata: ${payload}\n\n`);
            return true;
          };

          /**
           * The prologue is over. The cursor is the furthest position this
           * stream knows: the announced head, the highest id the replay
           * walked past (rows it withheld included) and the highest id
           * written, since a held live frame drained after the replay
           * carries an id past the head and a subscriber resuming from the
           * head alone would be sent it again. Null where none is known:
           * a head read that outran its budget with nothing to replay.
           */
          const announceLive = (): void => {
            if (state.closed) return;
            let reached: bigint | null = null;
            for (const candidate of [announcedHead, replayedTo, lastSentId]) {
              if (
                candidate !== null &&
                (reached === null || candidate > reached)
              ) {
                reached = candidate;
              }
            }
            const payload = JSON.stringify({
              type: STREAM_LIVE_EVENT,
              cursor: reached === null ? null : String(reached),
            });
            send(`event: ${STREAM_LIVE_EVENT}\ndata: ${payload}\n\n`);
          };

          // The prologue, in the order a client has to receive it:
          // where the stream is, then what it missed, then what happens
          // next. Ordered rather than concurrent because a client
          // applying frames as they arrive cannot otherwise tell which
          // of the first two it is holding.
          void (async () => {
            if (!(await announceCursor())) return;
            // True when there was nothing to catch up on, which is the
            // same thing as a catch-up that finished: either way what
            // was held is safe to deliver.
            let caughtUp = true;
            if (afterId !== null) {
              caughtUp = await replay(afterId);
            }
            // A catch-up that could not finish has already told the
            // client and closed. Releasing the hold on top of that would
            // deliver the live frames sitting AFTER the gap, which is
            // exactly what turns a short catch-up into one the client
            // cannot see is short.
            if (!caughtUp) return;
            await releaseHold();
          })();

          c.req.raw.signal.addEventListener("abort", () => {
            cleanup();
            void frames.return(undefined);
          });

          onCancel = () => {
            cleanup();
            void frames.return(undefined);
          };
        },
        cancel() {
          onCancel?.();
        },
      });

      return withPreparedHeaders(
        c,
        new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
      );
    }
  });

  return router;
}
