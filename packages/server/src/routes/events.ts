import { Hono } from "hono";
import { matchesTypePattern } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import { subscribe, subscribeEdges, wireEventName } from "../pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";

const KEEPALIVE_INTERVAL_MS = 30_000;
const REPLAY_BATCH_SIZE = 500;

export function eventRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /events — Server-Sent Events stream with replay support
  router.get("/", (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;
    const typeParam = c.req.query("type") ?? undefined;
    const lastEventId = c.req.header("Last-Event-ID");
    const allowedTypes = computeTypeFilter(apiKey);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Mutable flag used across async callbacks. Wrapped in an object
        // so TypeScript's narrowing doesn't assume the value is `false`
        // at the callsite when mutations happen inside async closures.
        const state: { closed: boolean } = { closed: false };

        const send = (data: string) => {
          if (state.closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            state.closed = true;
          }
        };

        // Keep-alive pings
        const keepAlive = setInterval(() => {
          send(":ping\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        const cleanup = () => {
          state.closed = true;
          clearInterval(keepAlive);
        };

        // Buffer live events while replaying
        const liveBuffer: ItemEventWithId[] = [];
        let replaying = !!lastEventId;

        // Subscribe to live events BEFORE starting replay to avoid gaps
        const events = subscribe({ typeFilter: typeParam, tenantId });
        const reader = events[Symbol.asyncIterator]();

        const sendEvent = (
          eventId: number | undefined,
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
          eventId: number | undefined,
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
          const afterId = parseInt(lastEventId, 10);
          if (!isNaN(afterId)) {
            void (async () => {
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
                  if (minRetained !== null && afterId < minRetained) {
                    const payload = JSON.stringify({
                      type: "catchup_too_old",
                      min_retained_id: minRetained,
                      requested: afterId,
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

                let lastReplayedId = afterId;

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
