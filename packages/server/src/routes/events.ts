import { Hono } from "hono";
import { matchesTypePattern } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, computeTypeFilter } from "../middleware/auth.js";
import { subscribe } from "../graphql/pubsub.js";

const KEEPALIVE_INTERVAL_MS = 30_000;

export function eventRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /events — Server-Sent Events stream
  router.get("/", (c) => {
    const apiKey = requireAuth(c);
    const tenantId = apiKey.tenant_id;
    const typeParam = c.req.query("type") ?? undefined;
    const lastEventId = c.req.header("Last-Event-ID");
    const allowedTypes = computeTypeFilter(apiKey);

    let eventId = parseInt(lastEventId ?? "0", 10) || 0;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const send = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };

        // Keep-alive pings
        const keepAlive = setInterval(() => {
          send(":ping\n\n");
        }, KEEPALIVE_INTERVAL_MS);

        // Start consuming events
        const events = subscribe({ typeFilter: typeParam, tenantId });
        const reader = events[Symbol.asyncIterator]();

        const pump = () => {
          reader
            .next()
            .then(({ value: event, done }) => {
              if (done || closed) {
                clearInterval(keepAlive);
                if (!closed) {
                  closed = true;
                  controller.close();
                }
                return;
              }

              // Type permission filtering
              if (
                allowedTypes &&
                !matchesTypePattern(event.item.type, allowedTypes)
              ) {
                pump();
                return;
              }

              eventId++;
              const sseData = {
                type: `item.${event.type}`,
                item: event.item,
                ...(event.metadata && { metadata: event.metadata }),
              };

              send(
                `id: ${String(eventId)}\nevent: item.${event.type}\ndata: ${JSON.stringify(sseData)}\n\n`,
              );
              pump();
            })
            .catch(() => {
              clearInterval(keepAlive);
              if (!closed) {
                closed = true;
                controller.close();
              }
            });
        };

        pump();

        // Clean up when the client disconnects
        c.req.raw.signal.addEventListener("abort", () => {
          closed = true;
          clearInterval(keepAlive);
          reader.return?.(undefined);
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
