import { Hono } from "hono";
import { matchesTypePattern } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import { subscribe, subscribeEdges, wireEventName } from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { PgClient } from "../storage/pg/connection.js";
import {
  acquireStreamRls,
  type StreamRlsContext,
} from "../storage/pg/streaming-rls.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

/**
 * Options for `eventRoutes`. `rlsEnforce` + `pgClient` enable T-146
 * session-level RLS on a dedicated pool connection for the lifetime
 * of the SSE stream. Without both set the route runs on the owner
 * connection — used for SQLite, for tenant-less callers (platform
 * admin / single-tenant self-host), and when RLS enforcement is
 * disabled instance-wide.
 */
export interface EventRoutesOptions {
  rlsEnforce: boolean;
  pgClient: PgClient | null;
}

export function eventRoutes(
  storage: Storage,
  options: EventRoutesOptions = { rlsEnforce: false, pgClient: null },
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /events — Server-Sent Events stream with replay support
  router.get("/", (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;
    const typeParam = c.req.query("type") ?? undefined;
    const lastEventId = c.req.header("Last-Event-ID");
    const allowedTypes = computeTypeFilter(apiKey);

    // T-146: dedicated-connection session-level RLS for the stream's
    // lifetime. Acquired lazily inside `start` so a setup failure
    // surfaces through the stream (the route still returns 200; the
    // failure aborts the stream cleanly). Tenant-less callers, SQLite,
    // and the RLS-disabled instance fall back to the owner connection.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // RLS context for this stream. Acquired up front; cleanup
        // runs exactly once via `releaseRls()` which is hooked into
        // every termination path (normal close, error, abort, catchup
        // terminal). Acquisition failure aborts the stream and the
        // client sees a closed connection (no rows leaked).
        let rlsCtx: StreamRlsContext | null = null;
        if (options.rlsEnforce && options.pgClient !== null && tenantId) {
          try {
            rlsCtx = await acquireStreamRls(options.pgClient, tenantId);
          } catch (err) {
            // Setup failed before any data was sent. Close the stream;
            // node-server propagates as an empty SSE response. No
            // tenant context was set — connection has already been
            // returned to or destroyed from the pool.
            try {
              controller.error(err);
            } catch {
              /* already closed */
            }
            return;
          }
        }
        let rlsReleased = false;
        const releaseRls = (): void => {
          if (rlsReleased || !rlsCtx) return;
          rlsReleased = true;
          // Fire-and-forget — cleanup must not block the abort /
          // controller-close hot path. Release is idempotent and
          // self-contained; failures destroy the connection rather
          // than risk a poisoned return to the pool.
          const ctx = rlsCtx;
          void ctx.release().catch(() => {
            /* logged inside disposeReserved; swallow here */
          });
        };
        // Mutable flag used across async callbacks. Wrapped in an object
        // so TypeScript's narrowing doesn't assume the value is `false`
        // at the callsite when mutations happen inside async closures.
        const state: { closed: boolean } = { closed: false };

        const send = (data: string) => {
          if (state.closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            // T-146: enqueue failed → controller is gone. Drive
            // cleanup() immediately so the reserved RLS connection
            // is released rather than waiting for the next pump
            // tick (which on an idle stream could be indefinite).
            // `cleanup()` is itself idempotent.
            cleanup();
          }
        };

        // Flush response headers immediately so reverse proxies that buffer
        // SSE bodies (notably Cloudflare Tunnel) deliver the 200 + content-type
        // to the client without waiting for the first event or the 30s
        // keep-alive ping. SSE comments are ignored by EventSource parsers.
        send(": connected\n\n");

        // Keep-alive pings
        const keepAlive = setInterval(() => {
          send(":ping\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        const cleanup = () => {
          state.closed = true;
          clearInterval(keepAlive);
          // T-146: release the RLS-pinned connection on every
          // termination path. Idempotent — safe to call from multiple
          // exit points (pump completion, error, abort, terminal
          // catchup event, server shutdown). The cleanup closure is
          // the single chokepoint; everything that closes the stream
          // calls it.
          releaseRls();
        };

        // Buffer live events while replaying
        const liveBuffer: ItemEventWithId[] = [];
        let replaying = !!lastEventId;

        // Subscribe to live events BEFORE starting replay to avoid gaps
        const events = subscribe({ typeFilter: typeParam, tenantId });
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
        // for subscribers in the same tenant.
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

        // Pump live item events — either buffer during replay or send directly
        const liveEdgeBuffer: EdgeEventWithId[] = [];
        const pump = () => {
          reader
            .next()
            .then(({ value: event, done }) => {
              if (done || state.closed) {
                cleanup();
                if (!state.closed) controller.close();
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
              cleanup();
              if (!state.closed) controller.close();
            });
        };

        pump();

        // Pump live edge events on a separate loop; replay pulls them from
        // the same event_log so buffering semantics mirror the item path.
        const edgeIter = subscribeEdges({ tenantId })[Symbol.asyncIterator]();
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

        // Replay missed events if Last-Event-ID was provided
        if (lastEventId) {
          // event_log.id is i64 (PG bigint, SQLite INTEGER). Parse as bigint
          // so cursors above Number.MAX_SAFE_INTEGER round-trip cleanly.
          let afterId: bigint | null;
          try {
            afterId = BigInt(lastEventId);
          } catch {
            afterId = null;
          }
          if (afterId !== null) {
            const afterIdResolved = afterId;
            // T-146: replay reads `storage.eventLog` — RLS-policy-
            // guarded tables. Install the ALS context so reads flow
            // through the reserved connection that carries
            // `marfa.tenant_id` + `marfa_app` role. The live pumps
            // (`pump` / `pumpEdges`) below don't touch storage —
            // they read from in-memory pubsub iterators — and so
            // don't need the ALS scope.
            const replay = async () => {
              try {
                // Detect stale cursors — clients whose `Last-Event-ID`
                // predates the retention window can't be faithfully caught
                // up from the event log. Emit a terminal `catchup_too_old`
                // control event and close the stream; the client is
                // expected to re-sync state and reconnect without a
                // Last-Event-ID. Scoped by tenant so a fresh tenant with
                // no events never trips the check.
                {
                  const minRetained = await storage.eventLog.getMinRetainedId(
                    tenantId ?? undefined,
                  );
                  if (minRetained !== null && afterIdResolved < minRetained) {
                    const payload = JSON.stringify({
                      type: "catchup_too_old",
                      min_retained_id: String(minRetained),
                      requested: String(afterIdResolved),
                    });
                    // Emit the terminal event using the same SSE framing
                    // (id / event / data / blank-line) as every other event
                    // on this stream. The id is the min retained id so a
                    // naive EventSource client won't store a cursor older
                    // than what the log can serve.
                    send(
                      `id: ${String(minRetained)}\nevent: catchup_too_old\ndata: ${payload}\n\n`,
                    );
                    // Close the stream: stop pumps, release iterators,
                    // end the underlying controller. No further events
                    // will be delivered — the client must re-sync state
                    // before reconnecting.
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

                // Replay in batches
                while (!state.closed) {
                  const batch = await storage.eventLog.getAfter(
                    lastReplayedId,
                    REPLAY_BATCH_SIZE,
                    tenantId ?? undefined,
                  );

                  if (batch.length === 0) break;

                  for (const event of batch) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state.closed is mutated by the cleanup() callback invoked from outside this loop; TS narrows it to `false` from the enclosing while-check but at runtime it can flip to true.
                    if (state.closed) return;
                    const isEdge = event.edge_id !== null;
                    // Type filter (`?type=`) applies to item events only.
                    // Edge events have no item type; skip them when the
                    // subscriber asked for a specific item type.
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
                        | ItemEventWithId["type"]
                        | EdgeEventWithId["type"],
                    );
                    send(
                      `id: ${String(event.id)}\nevent: ${replayWireType}\ndata: ${event.payload}\n\n`,
                    );
                    lastReplayedId = event.id;
                  }

                  if (batch.length < REPLAY_BATCH_SIZE) break;
                }

                // Drain buffered live events, skipping any already replayed
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
                // Replay failed — switch to live-only mode
                replaying = false;
                liveBuffer.length = 0;
                liveEdgeBuffer.length = 0;
              }
            };
            void (async () => {
              if (rlsCtx) {
                await rlsCtx.withInstalledContext(replay);
              } else {
                await replay();
              }
            })();
          } else {
            replaying = false;
          }
        }

        // Clean up when the client disconnects
        c.req.raw.signal.addEventListener("abort", () => {
          cleanup();
          void reader.return(undefined);
          void edgeIter.return(undefined);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return router;
}
