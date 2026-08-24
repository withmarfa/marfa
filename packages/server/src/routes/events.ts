import { Hono } from "hono";
import { ErrorCode, MarfaError, matchesTypePattern } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import { subscribe, subscribeEdges, wireEventName } from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { PgClient } from "../storage/pg/connection.js";
import { StreamPoolExhaustedError } from "../storage/pg/streaming-rls.js";
import {
  acquireStreamRls,
  type StreamRlsContext,
} from "../storage/pg/streaming-rls.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

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
export interface EventRoutesOptions {
  rlsEnforce: boolean;
  pgClient: PgClient | null;
  /** Override for the replay-slot reservation window; tests drive the
   *  exhaustion path with a short one. Default lives in streaming-rls. */
  streamReserveTimeoutMs?: number;
  /**
   * Ceiling on concurrent viewers per route instance — one per server
   * process in production, where the app is built once. `0` = uncapped (the
   * default). A deliberate memory bound, not a pool artifact: viewers
   * no longer hold database connections, so the cap exists for
   * deployments that want a stated limit rather than discovering one.
   */
  maxViewers?: number;
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
    const typeParam = c.req.query("type") ?? undefined;
    const lastEventId = c.req.header("Last-Event-ID");
    const allowedTypes = computeTypeFilter(apiKey);

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

          const liveBuffer: ItemEventWithId[] = [];
          let replaying = afterId !== null;

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
            if (
              allowedTypes &&
              !matchesTypePattern(event.item.type, allowedTypes)
            ) {
              return;
            }

            const wireType = wireEventName(event.type);
            const sseData = {
              type: wireType,
              item: event.item,
              ...(event.metadata && { metadata: event.metadata }),
            };

            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            send(
              `${idField}event: ${wireType}\ndata: ${JSON.stringify(sseData)}\n\n`,
            );
          };

          // Edge events don't carry an item type; the type filter (/events?type=)
          // applies to item events only. Edge events flow through unconditionally
          // for subscribers in the same space.
          const sendEdgeEvent = (
            eventId: bigint | undefined,
            event: EdgeEventWithId,
          ) => {
            if (typeParam) return;
            const wireType = wireEventName(event.type);
            const sseData = { type: wireType, edge: event.edge };
            const idField =
              eventId !== undefined ? `id: ${String(eventId)}\n` : "";
            send(
              `${idField}event: ${wireType}\ndata: ${JSON.stringify(sseData)}\n\n`,
            );
          };

          const liveEdgeBuffer: EdgeEventWithId[] = [];
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

                if (replaying) {
                  liveBuffer.push(event);
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
                if (replaying) {
                  liveEdgeBuffer.push(event);
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

          if (lastEventId) {
            if (afterId !== null) {
              const afterIdResolved = afterId;
              const replay = async () => {
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
                      cleanup();
                      void reader.return(undefined);
                      void edgeIter.return(undefined);
                      try {
                        controller.close();
                      } catch {
                        /* already closed */
                      }
                      return;
                    }
                  }

                  let lastReplayedId: bigint = afterIdResolved;
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
                      if (isEdge) {
                        if (typeParam) {
                          lastReplayedId = event.id;
                          continue;
                        }
                      } else if (typeParam) {
                        const parsed = JSON.parse(event.payload) as {
                          item?: { type?: string };
                        };
                        if (parsed.item?.type !== typeParam) {
                          lastReplayedId = event.id;
                          continue;
                        }
                      }
                      if (!isEdge && allowedTypes) {
                        const parsed = JSON.parse(event.payload) as {
                          item?: { type?: string };
                        };
                        if (
                          parsed.item?.type &&
                          !matchesTypePattern(parsed.item.type, allowedTypes)
                        ) {
                          lastReplayedId = event.id;
                          continue;
                        }
                      }

                      const replayWireType = wireEventName(
                        event.event_type as
                          ItemEventWithId["type"] | EdgeEventWithId["type"],
                      );
                      send(
                        `id: ${String(event.id)}\nevent: ${replayWireType}\ndata: ${event.payload}\n\n`,
                      );
                      lastReplayedId = event.id;
                    }

                    if (batch.length < REPLAY_BATCH_SIZE) break;
                  }

                  replaying = false;
                  for (const event of liveBuffer) {
                    if (state.closed) return;
                    if (
                      event.eventId !== undefined &&
                      event.eventId <= lastReplayedId
                    )
                      continue;
                    sendEvent(event.eventId, event);
                  }
                  liveBuffer.length = 0;
                  for (const event of liveEdgeBuffer) {
                    if (state.closed) return;
                    if (
                      event.eventId !== undefined &&
                      event.eventId <= lastReplayedId
                    )
                      continue;
                    sendEdgeEvent(event.eventId, event);
                  }
                  liveEdgeBuffer.length = 0;
                } catch {
                  replaying = false;
                  liveBuffer.length = 0;
                  liveEdgeBuffer.length = 0;
                }
              };
              void (async () => {
                try {
                  if (rlsCtx) {
                    await rlsCtx.withInstalledContext(replay);
                  } else {
                    await replay();
                  }
                } finally {
                  // The reservation exists for the replay alone; the
                  // live phase runs entirely off the emitter. Idempotent
                  // with cleanup()'s call, which stays as the safety net
                  // for a client that disconnects mid-replay.
                  releaseRls();
                }
              })();
            } else {
              replaying = false;
            }
          }

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

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
  });

  return router;
}
