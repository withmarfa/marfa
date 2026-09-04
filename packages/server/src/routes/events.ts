import { Hono } from "hono";
import { ErrorCode, MarfaError, matchesTypeFilter } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import {
  requireAuth,
  computeTypeFilter,
  roleBypassesPermissionMaps,
} from "../middleware/auth.js";
import {
  eventMatchesTypeFilter,
  subscribe,
  subscribeEdges,
  wireEventName,
} from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { PgClient, PgDb } from "../storage/pg/connection.js";
import { withRlsSpaceTransaction } from "../middleware/rls-space-context.js";
import type { ApiKey, Metadata } from "@withmarfa/shared";
import { filterMetadataForCaller } from "./util.js";
import { StreamPoolExhaustedError } from "../storage/pg/streaming-rls.js";
import {
  acquireStreamRls,
  STREAM_RESERVE_TIMEOUT_MS,
  type StreamRlsContext,
} from "../storage/pg/streaming-rls.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * How long the announcement waits for the log head before giving up on it.
 *
 * **Taken from the reservation window rather than chosen.** This route
 * already waits on the database once at stream setup — the replay slot —
 * and that wait is `STREAM_RESERVE_TIMEOUT_MS`, sized to ride out a burst
 * of stream turnover without leaving a client hanging. The head read asks
 * the same question at the same moment in a connection's life: how long
 * setup tolerates a database that is not answering. Importing the number
 * rather than restating it is what stops the two drifting, and the head
 * read is the half nobody would think to re-tune.
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
const HEAD_READ_TIMEOUT_MS = STREAM_RESERVE_TIMEOUT_MS;

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
 * Options for `eventRoutes`. `rlsEnforce` + `pgClient` enable
 * session-level RLS on a pool connection reserved ONLY for the replay
 * phase — live delivery flows from the in-process emitter, which the
 * subscription's space filter and the caller's type projection already
 * fence, so a viewer costs the database nothing once it is caught up.
 * Without both set the replay runs on the owner connection — used for
 * SQLite, for space-less callers (platform admin / single-space
 * self-host), and when RLS enforcement is disabled instance-wide.
 */
/** A live frame published while the stream was still holding delivery. */
type HeldFrame =
  | { kind: "item"; event: ItemEventWithId }
  | { kind: "edge"; event: EdgeEventWithId };

export interface EventRoutesOptions {
  rlsEnforce: boolean;
  pgClient: PgClient | null;
  /**
   * The request-context Drizzle instance, for the one bounded read this
   * route makes outside the replay: the event-log head it announces on
   * connect. Absent means that read runs unfenced on the owner
   * connection, which is the SQLite and space-less shape anyway.
   */
  pgDb?: PgDb | null;
  /** Override for the replay-slot reservation window; tests drive the
   *  exhaustion path with a short one. Default lives in streaming-rls. */
  streamReserveTimeoutMs?: number;
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
 * metadata, and a credential that bypasses the permission maps has
 * nothing to narrow, so neither is worth a decode. The stored string is
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
  // A credential that bypasses the maps has nothing to narrow, so it pays
  // no re-serialize. Without this an admin catching up on a backlog
  // rebuilt every metadata frame in it to arrive at the same bytes.
  if (roleBypassesPermissionMaps(apiKey)) return payload;
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
  options: EventRoutesOptions = { rlsEnforce: false, pgClient: null },
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  let liveViewers = 0;

  // GET /events — Server-Sent Events stream with replay support
  router.get("/", (c) => {
    const apiKey = requireAuth(c);
    const spaceId = apiKey.space_id;
    const typeParam = parseTypeFilter(c.req.query("type"));
    const edgeMode = parseEdgeMode(c.req.query("edges"));
    const lastEventId = c.req.header("Last-Event-ID");
    // The SSE stream is the one type filter with no query to hang a
    // predicate on, so it asks `matchesTypeFilter` — written over the same
    // ranking the SQL compilers use, so a streamed answer and a queried one
    // cannot disagree about the same grant.
    const typeFilter = computeTypeFilter(apiKey);

    return (async () => {
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
      // bracketed so a failed setup never strands the count or a
      // reservation.
      liveViewers += 1;

      // Object wrapper for the same reason as `state` below: the catch
      // block's flow analysis does not credit an assignment made inside
      // the try, and would read the reservation as never-held.
      const reservation: { ctx: StreamRlsContext | null } = { ctx: null };
      try {
        // event_log.id is PG bigint / SQLite INTEGER — parse as BigInt so
        // cursors above Number.MAX_SAFE_INTEGER round-trip cleanly.
        // Parsed before the stream exists because whether a replay will
        // run decides whether a database connection is needed at all.
        let afterId: bigint | null = null;
        if (lastEventId) {
          try {
            afterId = BigInt(lastEventId);
          } catch {
            afterId = null;
          }
        }

        // A database connection is reserved ONLY when this viewer has a
        // catch-up to run, and it is released the moment the replay ends
        // — the stream's live phase never holds one. Acquired BEFORE the
        // response exists, so a pool with no free slot answers a real
        // 503 the client can retry on; acquired inside `start`, the
        // failure could only surface as a broken stream behind a 200
        // already sent.
        if (
          afterId !== null &&
          options.rlsEnforce &&
          options.pgClient !== null &&
          spaceId
        ) {
          try {
            reservation.ctx = await acquireStreamRls(
              options.pgClient,
              spaceId,
              {
                ...(options.streamReserveTimeoutMs !== undefined && {
                  reserveTimeoutMs: options.streamReserveTimeoutMs,
                }),
              },
            );
          } catch (err) {
            if (err instanceof StreamPoolExhaustedError) {
              throw new MarfaError(
                ErrorCode.STREAM_CAPACITY_EXHAUSTED,
                "No replay capacity is available right now; retry shortly",
                { reason: "replay_contention" },
              );
            }
            throw err;
          }
        }

        return buildStream(afterId, reservation.ctx);
      } catch (err) {
        // The stream never started, so its cleanup will never run: the
        // slot and any reservation are this path's to give back.
        liveViewers -= 1;
        if (reservation.ctx) {
          void reservation.ctx.release().catch(() => undefined);
        }
        throw err;
      }
    })();

    function buildStream(
      afterId: bigint | null,
      acquiredCtx: StreamRlsContext | null,
    ): Response {
      // Set inside start(), fired from cancel(): a consumer that cancels
      // the stream (rather than dropping the connection, which fires the
      // abort signal) must still release the viewer slot and any replay
      // reservation.
      let onCancel: (() => void) | null = null;

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const rlsCtx: StreamRlsContext | null = acquiredCtx;
          let rlsReleased = false;
          const releaseRls = (): void => {
            if (rlsReleased || !rlsCtx) return;
            rlsReleased = true;
            // Fire-and-forget — must not block the abort/close path.
            // Failures destroy the connection rather than risk a poisoned pool return.
            const ctx = rlsCtx;
            void ctx.release().catch(() => {
              /* logged inside disposeReserved; swallow here */
            });
          };
          // Object wrapper prevents TS narrowing from assuming `closed` stays `false` across async closures.
          const state: { closed: boolean } = { closed: false };

          // Aborting detaches the emitter listeners immediately.
          // iterator.return() alone cannot: a generator suspended on an
          // event that never arrives stays suspended, and a quiet space
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
            releaseRls();
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

          // Subscribe BEFORE replay starts to avoid gaps.
          const events = subscribe({
            typeFilter: typeParam,
            spaceId,
            signal: subscriptionAbort.signal,
          });
          const reader = events[Symbol.asyncIterator]();

          const sendEvent = (
            eventId: bigint | undefined,
            event: ItemEventWithId,
          ) => {
            if (!matchesTypeFilter(event.item.type, typeFilter)) {
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
            if (edgeMode === "none") return;
            const wireType = wireEventName(event.type);
            const sseData = { type: wireType, edge: event.edge };
            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
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
                  heldFrames.push({ kind: "item", event });
                } else {
                  sendEvent(event.eventId, event);
                }
                pump();
              })
              .catch(() => {
                const wasOpen = !state.closed;
                cleanup();
                if (wasOpen) {
                  try {
                    controller.close();
                  } catch {
                    /* already closed */
                  }
                }
              });
          };

          pump();

          const edgeIter = subscribeEdges({
            spaceId,
            signal: subscriptionAbort.signal,
          })[Symbol.asyncIterator]();
          const pumpEdges = () => {
            edgeIter
              .next()
              .then(({ value: event, done }) => {
                if (done || state.closed) return;
                if (holding) {
                  heldFrames.push({ kind: "edge", event });
                } else {
                  sendEdgeEvent(event.eventId, event);
                }
                pumpEdges();
              })
              .catch(() => {
                /* cleanup already handles termination */
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

          const replay = async (afterIdResolved: bigint): Promise<void> => {
            try {
              // Detect stale cursors — clients whose `Last-Event-ID`
              // predates the retention window can't be faithfully caught
              // up from the event log. Emit a terminal `catchup_too_old`
              // control event and close the stream; the client is
              // expected to re-sync state and reconnect without a
              // Last-Event-ID. Scoped by space so a fresh space with
              // no events never trips the check.
              {
                const minRetained = await storage.eventLog.getMinRetainedId(
                  spaceId ?? undefined,
                );
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
                  return;
                }
              }

              let lastReplayedId: bigint = afterIdResolved;
              // The cursor above paginates `getAfter` and advances
              // past every row this loop walks, rows a filter
              // withheld included. That makes it the wrong thing to
              // dedupe the live buffer against. Postgres assigns
              // `event_log.id` from an identity column before
              // commit, so a transaction holding a lower id can
              // commit after one holding a higher id; comparing a
              // buffered live event against a high-water mark then
              // discards an event this client has never seen, with
              // its cursor already past it, so it never asks again.
              // What is safe to discard is an id this replay
              // actually sent, so that is what is recorded — into a set
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
                  spaceId ?? undefined,
                );

                if (batch.length === 0) break;

                for (const event of batch) {
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state.closed is mutated by the cleanup() callback invoked from outside this loop; TS narrows it to `false` from the enclosing while-check but at runtime it can flip to true.
                  if (state.closed) return;
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
                  // `typeFilter.allowed` is undefined for exactly the
                  // credentials that bypass the permission maps, so
                  // neither needs the row decoded at all. Typed as
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
                  const parsedItem: unknown = parsed?.item;
                  const itemType =
                    typeof parsedItem === "object" && parsedItem !== null
                      ? (parsedItem as { type?: string }).type
                      : undefined;
                  // The same function the live path filters on, and
                  // called here rather than reimplemented: `?type=`
                  // names a subtree, so a string comparison drops a
                  // subtype the live stream delivers, and the client
                  // has no way to see that its view narrowed on
                  // reconnect. Passed the arguments live passes, so
                  // the two cannot resolve the same filter
                  // differently. An item row whose payload carries no
                  // item type is withheld, as it was before.
                  //
                  // `!isEdge` is load-bearing rather than a shortcut.
                  // An edge row carries no item type at all, so without
                  // it every edge falls into the withheld-for-no-type
                  // arm and a type filter goes on silencing edges on
                  // this path alone — the live/replay disagreement this
                  // file exists to prevent, reintroduced by the guard
                  // above that used to make the question unreachable.
                  if (
                    !isEdge &&
                    typeParam !== undefined &&
                    (itemType === undefined ||
                      !eventMatchesTypeFilter(itemType, typeParam))
                  ) {
                    lastReplayedId = event.id;
                    continue;
                  }
                  if (
                    typeFilter.allowed !== undefined &&
                    itemType &&
                    !matchesTypeFilter(itemType, typeFilter)
                  ) {
                    lastReplayedId = event.id;
                    continue;
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
                  // re-serialized, so replaying an edge event, or any
                  // event for a credential that bypasses the maps,
                  // pays nothing.
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
            } catch {
              // A catch-up that failed leaves the client short of
              // events it will never ask for again, and the held frames
              // sit after that gap — sending them would present an
              // incomplete stream as a complete one.
              heldFrames.length = 0;
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

          /**
           * Read the log head this stream announces.
           *
           * Fenced the way an ordinary space-scoped read is fenced, and
           * deliberately not through the streaming reservation: this is
           * one scalar read at setup, not a walk over rows held open for
           * the length of a response. Reserving here would put every
           * fresh viewer in the same five-slot queue as every replaying
           * one, and answer 503 to the client with nothing to catch up
           * on.
           */
          const readHeadEventId = async (): Promise<bigint | null> => {
            const read = (): Promise<bigint | null> =>
              storage.eventLog.getMaxId(spaceId ?? undefined);
            const pgDb = options.pgDb ?? null;
            if (options.rlsEnforce && pgDb !== null && spaceId) {
              return withRlsSpaceTransaction(pgDb, spaceId, read);
            }
            return read();
          };

          /**
           * The head read, bounded.
           *
           * The read itself cannot be cancelled — a query already queued
           * behind a saturated pool runs when its turn comes whatever this
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
              // pool is busy. Closing here would turn a saturated pool
              // into a disconnect for every connecting client at once,
              // and each would reconnect into the same pool. So the
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
            try {
              if (afterId !== null) {
                const runReplay = (): Promise<void> => replay(afterId);
                if (rlsCtx) {
                  await rlsCtx.withInstalledContext(runReplay);
                } else {
                  await runReplay();
                }
              }
            } finally {
              // The reservation exists for the replay alone; the live
              // phase runs entirely off the emitter. Idempotent with
              // cleanup()'s call, which stays as the safety net for a
              // client that disconnects mid-replay.
              releaseRls();
            }
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
