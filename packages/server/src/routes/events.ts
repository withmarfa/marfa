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
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import {
  eventMatchesTypeFilter,
  subscribe,
  subscribeEdges,
  wireEventName,
} from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { ApiKey, Metadata } from "@withmarfa/shared";
import { filterMetadataForCaller } from "./util.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * How long the announcement waits for the log head before giving up on it.
 *
 * Five seconds: how long stream setup tolerates a database that is not
 * answering, sized to ride out a burst of stream turnover without leaving
 * a client hanging.
 *
 * A bound is needed at all because the hold is new. Every connection now
 * withholds live delivery from its first moment so the announcement can
 * be the first frame, and the frames it withholds accumulate with no
 * ceiling. On `main` a connection held only while replaying, and that
 * wait was already bounded — so an unbounded read here is the one way a
 * saturated app pool could leave a viewer counted, subscribed, and
 * buffering forever.
 *
 * **What it degrades to is the point.** Announcing nothing and releasing
 * the hold leaves the client exactly where every client stood before the
 * announcement existed: connected, live, holding no cursor of its own.
 * That is a documented state its reconnect path already handles. A client
 * whose frames are held indefinitely is in no state at all.
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
 * of its own to re-read and no tombstone when it goes. A type filter used
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
  /** Live frames held during the prologue outgrew {@link MAX_HELD_FRAMES}. */
  | "backlog_overflow"
  /** The item subscription failed for a reason that was not the client leaving. */
  | "live_delivery_failed"
  /** The edge subscription did, which stops half the stream and nothing else. */
  | "edge_delivery_failed";

/**
 * Most live frames one connection holds while its prologue runs.
 *
 * **Chosen as a memory bound, not derived from anything.** An earlier
 * version of this comment claimed it followed from `REPLAY_DEDUPE_WINDOW`
 * because the two bounded the same population from opposite sides. They
 * do not: that window holds the last few ids the replay actually SENT,
 * after filtering, while this holds live frames on their way in — and
 * whether a held frame's id is still inside that window depends on how
 * many rows the replay sent after it, which is a property of the
 * backlog's length rather than of this buffer's. Neither number is a
 * function of the other, and moving one does not require moving the
 * other.
 *
 * **What the number is actually for.** The hold lasts only as long as the
 * prologue — one head read, plus a replay when the client sent a cursor.
 * The buffer grows as the product of the instance's write rate and that
 * duration, and the prologue does not get faster because the buffer got
 * bigger, so past some size holding more only defers the same answer at a
 * higher cost. The job of the number is to sit above what an ordinary
 * prologue on a busy instance reaches and below what would matter if a
 * pathological one did not stop.
 *
 * Five hundred because that is what this route already treats as a
 * sensible number of event-shaped things for one connection to hold at
 * once — `REPLAY_BATCH_SIZE` is the same figure for the replay's own
 * read. That is a precedent being reused, not a derivation: if the batch
 * size moves for reasons of its own, this does not have to follow.
 *
 * **What it costs at the boundary, stated because it is a real cost.**
 * `REPLAY_DEDUPE_WINDOW` degrades gracefully at its own edge — past it a
 * client receives a second copy carrying an id it already absorbed, which
 * is why that number can be a judgment rather than a proof. This one does
 * not degrade: at the cap the stream terminates where nothing worse than
 * a duplicate would otherwise have happened. That is the deliberate
 * trade — a bounded, announced, resumable termination in place of a
 * buffer with no ceiling — and it is worth knowing it is a trade.
 *
 * **What it costs per holding viewer.** A held frame is a two-field
 * wrapper around the event object the emitter broadcast — the same object
 * every other subscriber received, not a copy — so the marginal cost is
 * the wrappers, and the retained cost is keeping up to this many
 * already-published events alive until the prologue ends. The viewer
 * ceiling bounds how many connections can be holding at once; this bounds
 * what each one accumulates, which is the half nothing bounded before.
 */
const MAX_HELD_FRAMES = 500;

/** A live frame published while the stream was still holding delivery. */
type HeldFrame =
  | { kind: "item"; event: ItemEventWithId }
  | { kind: "edge"; event: EdgeEventWithId };

export interface EventRoutesOptions {
  /** Override for the head-read budget; tests drive the degraded path —
   *  no announcement, hold released — with a short one. Default is
   *  `HEAD_READ_TIMEOUT_MS`. */
  headReadTimeoutMs?: number;
  /**
   * Ceiling on concurrent viewers per route instance — one per server
   * process in production, where the app is built once. `0` = uncapped (the
   * default). A deliberate memory bound, not a pool artifact: viewers
   * no longer hold database connections, so the cap exists for
   * deployments that want a stated limit rather than discovering one.
   */
  maxViewers?: number;
}

/**
 * Narrow a decoded replay payload to what this subscriber may read.
 *
 * The replay re-sends `event_log.payload` verbatim, so the live path's
 * filter never sees it. `parsed` is the row the replay loop already
 * decoded, or null when it decoded nothing — an edge frame carries no
 * metadata, and a caller with no credential at all has no map to narrow
 * against, so neither is worth a decode. The stored string is
 * returned as written in both cases, and in every case where the payload
 * turns out to carry no extensions to narrow.
 *
 * A payload that does not decode never reaches here: the loop skips that
 * row rather than sending it. Passing the bytes through would hand a
 * subscriber whatever they hold regardless of its permissions, which is
 * the one thing this function exists to prevent, and a string that is not
 * JSON would not decode on the client either — so withholding it costs
 * the subscriber nothing it could have used.
 */
function filterReplayPayload(
  payload: string,
  parsed: Record<string, unknown> | null,
  apiKey: ApiKey | undefined,
): string {
  if (parsed === null) return payload;
  // Shape-checked rather than presence-checked. `filterMetadataForCaller`
  // hands `.extensions` to a filter that iterates its keys, so a stored
  // payload whose `metadata` lacks that block — an older shape, or a
  // hand-written row — would throw inside `replay()`, whose catch ends
  // the catch-up silently and leaves the client short of events it will
  // never ask for again.
  const metadata: unknown = parsed.metadata;
  if (metadata === null || typeof metadata !== "object") return payload;
  const extensions: unknown = (metadata as Record<string, unknown>).extensions;
  if (extensions === null || typeof extensions !== "object") return payload;
  return JSON.stringify({
    ...parsed,
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
 * hold this parameter to, and refused on the same terms.** The stream
 * used to accept any string and then match nothing with it, which is the
 * worst answer a filter can give: a 200 and an empty stream, which a
 * client cannot tell from a quiet instance. A spelling the list surfaces
 * reject now reaches the caller as the rejection they already get there
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
    const typeFilter = computeTypeFilter(apiKey);

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

          const send = (data: string) => {
            if (state.closed) return;
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
           * **The last id written, which is not always the highest, and
           * that is deliberate.** `event_log.id` is assigned before
           * commit, so a lower id can commit after a higher one and reach
           * a client afterwards; the SSE `id:` field has carried that
           * property since long before this line, and the documented
           * client rule is written against it — store the last id you
           * received rather than the highest you have seen. Taking a
           * maximum here would contradict that rule and skip the
           * late-committing event. Resuming from this value can therefore
           * re-deliver a row, which a client applying payloads by id
           * already absorbs, and cannot skip one.
           */
          let lastSentId: bigint | null = null;

          // Subscribe BEFORE replay starts to avoid gaps.
          const events = subscribe({
            typeFilter: typeParam,
            signal: subscriptionAbort.signal,
          });
          const reader = events[Symbol.asyncIterator]();

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
            const sseData = {
              type: wireType,
              item: event.item,
              // The same narrowing every REST read of metadata goes
              // through. Without it a credential holding nothing on a
              // namespace still received its contents, for every item
              // whose type it could read — the type filter above is not
              // a substitute, because it says nothing about namespaces.
              //
              // **Every item frame that carries metadata, not just
              // `metadata.changed`.** `item.created`, `item.updated`,
              // `item.restored` and `item.state_changed` all publish
              // with the row attached, and they all serialize here. A
              // filter keyed on the wire name would have left four
              // frames unnarrowed while reading as complete.
              ...(event.metadata && {
                metadata: filterMetadataForCaller(event.metadata, apiKey),
              }),
            };

            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            if (eventId !== undefined) lastSentId = eventId;
            send(
              `${idField}event: ${wireType}\ndata: ${JSON.stringify(sseData)}\n\n`,
            );
          };

          // Edge events don't carry an item type, so `?type=` says nothing
          // about them: it names the item types this subscriber wants, and
          // an edge is not an item. Silencing them under a type filter was
          // the wrong reading of that — it left a filtered client watching
          // two types and never learning about the edges joining them,
          // which is the half nothing else can reconstruct. `?edges=none`
          // is the opt-out, and it is independent of the type filter.
          const sendEdgeEvent = (
            eventId: bigint | undefined,
            event: EdgeEventWithId,
          ) => {
            if (!edgesReachThisStream) return;
            const wireType = wireEventName(event.type);
            const sseData = { type: wireType, edge: event.edge };
            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            if (eventId !== undefined) lastSentId = eventId;
            send(
              `${idField}event: ${wireType}\ndata: ${JSON.stringify(sseData)}\n\n`,
            );
          };

          const pump = () => {
            reader
              .next()
              .then(({ value: event, done }) => {
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
                  holdFrame({ kind: "item", event });
                } else {
                  sendEvent(event.eventId, event);
                }
                pump();
              })
              .catch((err: unknown) => {
                // Already closed means the client left and `cleanup` has
                // run: the pending `next()` rejecting with the abort is
                // the subscription ending, not a failure.
                if (state.closed) return;
                console.warn(
                  `[events] closing the stream: item delivery failed (${String(err)})`,
                );
                failStream("live_delivery_failed");
              });
          };

          // The pumps run before the helpers they call are initialized,
          // which is safe and deliberate: only their `.then`/`.catch`
          // callbacks reach those, and the first of those cannot run
          // until this synchronous body has finished. Starting them here
          // is what attaches the emitter listeners, and moving that later
          // would widen the window in which a publish has nobody
          // listening.
          pump();

          const edgeIter = subscribeEdges({
            signal: subscriptionAbort.signal,
          })[Symbol.asyncIterator]();
          const pumpEdges = () => {
            edgeIter
              .next()
              .then(({ value: event, done }) => {
                if (done || state.closed) return;
                if (holding) {
                  holdFrame({ kind: "edge", event });
                } else {
                  sendEdgeEvent(event.eventId, event);
                }
                pumpEdges();
              })
              .catch((err: unknown) => {
                // The same discrimination the item pump makes, and the
                // same handling, because the alternative is worse here
                // rather than better: swallowing this ends edge delivery
                // for the life of the connection while item delivery
                // carries on, so the client keeps receiving events and
                // never learns it has stopped hearing about half of
                // them. Half a stream that looks whole is the one shape
                // a durable client cannot detect.
                if (state.closed) return;
                console.warn(
                  `[events] closing the stream: edge delivery failed (${String(err)})`,
                );
                failStream("edge_delivery_failed");
              });
          };
          pumpEdges();

          /**
           * End the stream from a terminal decision rather than from a
           * client disconnect: release the viewer slot, detach the
           * emitter listeners, and close the response body.
           */
          const endStream = (): void => {
            const wasOpen = !state.closed;
            cleanup();
            void reader.return(undefined);
            void edgeIter.return(undefined);
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
           * The one exit every "this stream can no longer honour what it
           * opened with" path takes, so the four causes cannot drift into
           * four different behaviors — which is how one of them came to
           * end the connection, one to end half of it silently, and one
           * to carry on as though nothing had happened.
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

          /**
           * Hold one live frame until the prologue is done with it.
           *
           * The cap is enforced here rather than at the two call sites,
           * for the reason the single buffer exists at all: a rule
           * written twice is a rule one of the two kinds of frame will
           * eventually stop obeying.
           *
           * **A frame that will not be delivered is not held, and this is
           * the load-bearing half.** The cap used to count frames the
           * release path was guaranteed to discard, so traffic a
           * subscriber had explicitly excluded could still exhaust its
           * buffer and terminate its stream: `?edges=none` could be
           * killed by edge events, and a credential scoped to one type by
           * events of another. Narrowing the subscription made it worse
           * rather than better, which is the opposite of what a filter is
           * for, and a subscriber that wants items only asks for exactly
           * that configuration. Both questions are the ones the release path
           * asks, asked here through the same two predicates so they
           * cannot drift, and both are stable for the life of the
           * connection so asking early cannot answer differently.
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
           */
          const holdFrame = (frame: HeldFrame): void => {
            const deliverable =
              frame.kind === "edge"
                ? edgesReachThisStream
                : itemPassesProjection(frame.event);
            if (!deliverable) return;
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
            try {
              // Detect stale cursors — clients whose `Last-Event-ID`
              // predates the retention window can't be faithfully caught
              // up from the event log. Emit a terminal `catchup_too_old`
              // control event and close the stream; the client is
              // expected to re-sync state and reconnect without a
              // Last-Event-ID. A fresh instance with no events never
              // trips the check.
              {
                const minRetained = await storage.eventLog.getMinRetainedId();
                if (minRetained !== null && afterIdResolved < minRetained) {
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
                  return false;
                }
              }

              // What is safe to discard is an id this replay actually
              // sent, so that is what is recorded rather than the
              // cursor, which advances past every row this loop walks,
              // rows a filter withheld included. Recorded into a set
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

                if (batch.length === 0) break;

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
                    continue;
                  }
                  // Decoded once for the whole row, shared by the type
                  // checks and the narrowing below. An edge frame
                  // carries no item type and no metadata, and
                  // `typeFilter.allowed` is undefined for one caller
                  // only — one presenting no credential, which
                  // `requireAuth` has already refused before this route
                  // reaches here — so neither needs the row decoded at
                  // all. Nothing bypasses the maps. Typed as
                  // unknown-valued rather than as an event: this is a
                  // stored string, so its declared shape is a claim
                  // about it rather than a fact, and the checks that
                  // keep a mis-shaped row from throwing would read as
                  // unnecessary against a declared type.
                  let parsed: Record<string, unknown> | null = null;
                  if (
                    !isEdge &&
                    (typeParam !== undefined ||
                      typeFilter.allowed !== undefined)
                  ) {
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
                      lastReplayedId = event.id;
                      continue;
                    }
                  }
                  // Everything that classifies a row lives inside this
                  // branch, and `parsed !== null` is exactly the
                  // condition under which it was decoded — an edge row,
                  // or a subscriber with neither filter, never reaches
                  // it and is never asked to name a type it does not
                  // carry.
                  //
                  // **One decision about a row that cannot be
                  // classified, rather than two checks reaching
                  // opposite conclusions about it.** These were adjacent
                  // and disagreed: the type filter withheld an item row
                  // whose payload named no type, while the permission
                  // narrowing three lines below guarded on the same
                  // value being present and so let it through
                  // unnarrowed. The check that failed open was the
                  // permission one. Nothing in the tree writes that
                  // payload today — the publisher always attaches the
                  // item — but that is a property of the current
                  // writers rather than of this code, and it is not one
                  // a permission check should be resting on.
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
                      lastReplayedId = event.id;
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
                      continue;
                    }
                    if (
                      typeFilter.allowed !== undefined &&
                      !matchesTypeFilter(named, typeFilter)
                    ) {
                      lastReplayedId = event.id;
                      continue;
                    }
                  }

                  const replayWireType = wireEventName(
                    event.event_type as
                      ItemEventWithId["type"] | EdgeEventWithId["type"],
                  );
                  // The stored payload is re-sent as a string, so the
                  // live path's filter never touched it: this is a
                  // second, independent copy of the same disclosure
                  // and needs its own narrowing. It applies to every
                  // stored frame carrying metadata, which is four
                  // event types besides `metadata.changed`. Only a
                  // payload that actually carries a metadata block is
                  // re-serialized, so replaying an edge event pays
                  // nothing.
                  lastSentId = event.id;
                  send(
                    `id: ${String(event.id)}\nevent: ${replayWireType}\ndata: ${filterReplayPayload(event.payload, parsed, apiKey)}\n\n`,
                  );
                  // Only here. A row the loop skipped above was not
                  // sent, so its live copy is not a duplicate.
                  rememberReplayed(event.id);
                  lastReplayedId = event.id;
                }

                if (batch.length < REPLAY_BATCH_SIZE) break;
              }
              return true;
            } catch (err) {
              // A catch-up that failed leaves the client short of events
              // it will never ask for again, and it used to fail by
              // clearing the buffers and carrying on: the connection
              // stayed open, the announcement said nothing, and the
              // client had no way to tell a truncated backlog from a
              // complete one. `isSubtypeOf` throwing on an unresolvable
              // chain is a reachable way in now that this path resolves
              // subtypes, and on the live path the same failure already
              // ends the stream where the client can see it.
              //
              // The cursor is named in the log because it is the only
              // thing that identifies which catch-up stopped and where,
              // and it is the row after it that has to be looked at.
              console.warn(
                `[events] closing the stream: the catch-up could not complete after event ${String(lastReplayedId)} (${String(err)})`,
              );
              failStream("replay_failed");
              return false;
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
           * An id evicted from the window is sent a second time carrying
           * the same `id:`, which a client applying a payload by id
           * already absorbs. The comparison this replaces failed the
           * other way, by dropping an event the client had no way to
           * learn it was missing.
           *
           * Stops rather than continuing when the stream closed
           * mid-drain, so nothing is written into a controller that is
           * gone.
           */
          const releaseHold = (): void => {
            holding = false;
            for (const frame of heldFrames) {
              if (state.closed) break;
              const eventId = frame.event.eventId;
              if (eventId !== undefined && replayedIds.has(eventId)) continue;
              if (frame.kind === "item") sendEvent(eventId, frame.event);
              else sendEdgeEvent(eventId, frame.event);
            }
            heldFrames.length = 0;
          };

          /** Read the log head this stream announces. */
          const readHeadEventId = (): Promise<bigint | null> =>
            storage.eventLog.getMaxId();

          /**
           * The head read, bounded.
           *
           * The read itself cannot be cancelled — a query already waiting
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
              // stream stays open with no announcement, which is the
              // state every client was in before this frame existed, and
              // the caller releases the hold on its way past.
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
            const payload = JSON.stringify({
              type: STREAM_CURSOR_EVENT,
              cursor: String(head ?? 0n),
            });
            send(`event: ${STREAM_CURSOR_EVENT}\ndata: ${payload}\n\n`);
            return true;
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
            releaseHold();
          })();

          c.req.raw.signal.addEventListener("abort", () => {
            cleanup();
            void reader.return(undefined);
            void edgeIter.return(undefined);
          });

          onCancel = () => {
            cleanup();
            void reader.return(undefined);
            void edgeIter.return(undefined);
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
