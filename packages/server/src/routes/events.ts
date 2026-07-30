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
 * Options for `eventRoutes`. `rlsEnforce` + `pgClient` enable
 * session-level RLS on a dedicated pool connection for the lifetime
 * of the SSE stream. Without both set the route runs on the owner
 * connection — used for SQLite, for space-less callers (platform
 * admin / single-space self-host), and when RLS enforcement is
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
    const spaceId = apiKey.space_id;
    const typeParam = c.req.query("type") ?? undefined;
    const lastEventId = c.req.header("Last-Event-ID");
    const allowedTypes = computeTypeFilter(apiKey);

    // Acquire a dedicated pool connection and apply session-level RLS for
    // the stream's lifetime. Acquired lazily inside `start` so a setup
    // failure surfaces through the stream (the route still returns 200;
    // the failure aborts the stream cleanly). Space-less callers, SQLite,
    // and the RLS-disabled instance fall back to the owner connection.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let rlsCtx: StreamRlsContext | null = null;
        if (options.rlsEnforce && options.pgClient !== null && spaceId) {
          try {
            rlsCtx = await acquireStreamRls(options.pgClient, spaceId);
          } catch (err) {
            // Setup failed before any data was sent; close so the client
            // sees a clean disconnect rather than a hanging connection.
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
          // Fire-and-forget — must not block the abort/close path.
          // Failures destroy the connection rather than risk a poisoned pool return.
          const ctx = rlsCtx;
          void ctx.release().catch(() => {
            /* logged inside disposeReserved; swallow here */
          });
        };
        // Object wrapper prevents TS narrowing from assuming `closed` stays `false` across async closures.
        const state: { closed: boolean } = { closed: false };

        const send = (data: string) => {
          if (state.closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            // Controller gone — cleanup immediately rather than waiting for the next pump tick.
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
          releaseRls();
        };

        const liveBuffer: ItemEventWithId[] = [];
        let replaying = !!lastEventId;

        // Subscribe BEFORE replay starts to avoid gaps.
        const events = subscribe({ typeFilter: typeParam, spaceId });
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

        const edgeIter = subscribeEdges({ spaceId })[Symbol.asyncIterator]();
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
          // event_log.id is PG bigint / SQLite INTEGER — parse as BigInt so
          // cursors above Number.MAX_SAFE_INTEGER round-trip cleanly.
          let afterId: bigint | null;
          try {
            afterId = BigInt(lastEventId);
          } catch {
            afterId = null;
          }
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
