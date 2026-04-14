import { Hono } from "hono";
import { matchesTypePattern } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import { subscribe } from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";
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

          const sseData = {
            type: `item.${event.type}`,
            item: event.item,
            ...(event.metadata && { metadata: event.metadata }),
          };

          const idField =
            eventId !== undefined ? `id: ${String(eventId)}\n` : "";
          send(
            `${idField}event: item.${event.type}\ndata: ${JSON.stringify(sseData)}\n\n`,
          );
        };

        // Pump live events — either buffer during replay or send directly
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

        // Replay missed events if Last-Event-ID was provided
        if (lastEventId) {
          const afterId = parseInt(lastEventId, 10);
          if (!isNaN(afterId)) {
            void (async () => {
              try {
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
                    // Type filtering
                    if (typeParam) {
                      const parsed = JSON.parse(event.payload) as {
                        item?: { type?: string };
                      };
                      if (parsed.item?.type !== typeParam) continue;
                    }
                    if (allowedTypes) {
                      const parsed = JSON.parse(event.payload) as {
                        item?: { type?: string };
                      };
                      if (
                        parsed.item?.type &&
                        !matchesTypePattern(parsed.item.type, allowedTypes)
                      )
                        continue;
                    }

                    send(
                      `id: ${String(event.id)}\nevent: item.${event.event_type}\ndata: ${event.payload}\n\n`,
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
              } catch {
                // Replay failed — switch to live-only mode
                replaying = false;
                liveBuffer.length = 0;
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
