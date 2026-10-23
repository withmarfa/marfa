import { createRoute, z } from "@hono/zod-openapi";
import { makeErrorResponseSchema } from "../openapi.js";
import { STREAM_EXAMPLE } from "../openapi-finalize.js";

export const EventQuerySchema = z.object({
  copy: z
    .enum(["1"])
    .optional()
    .describe(
      "Set to `1` for a copy stream, which a working copy follows. It takes `edges=all` and no other parameter. Its `stream_cursor` and `stream_live` carry `instance_id` and `reach`, and its item frames carry `listed`.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      "Only send item events for these types and their subtypes: a comma-separated list of up to 10, such as `core.note,app.*`. A pattern matches the types you can read. Edge events aren't filtered. Leave it out for every type.",
    ),
  edges: z
    .enum(["all", "none"])
    .openapi({ default: "all" })
    .optional()
    .describe(
      "Set to `none` to leave out edge events. You receive an edge event only if you could read the edge with `GET /edges/{id}`.",
    ),
});

export const eventStreamRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "streamEvents",
  tags: ["Event stream"],
  summary: "Stream change events",
  description:
    "Opens a Server-Sent Events stream of the changes to items and edges that you can read. Send `Last-Event-ID` to resume after a disconnect, or `copy=1` to follow a working copy.",
  security: [{ bearerAuth: [] }],
  request: {
    query: EventQuerySchema,
    headers: z.object({
      "X-Marfa-Reach": z
        .string()
        .regex(new RegExp("^[0-9a-f]{64}$"))
        .optional()
        .describe(
          "On a copy stream, the `reach` from the last `stream_cursor` or `stream_live` you received. Send it with `Last-Event-ID` to resume, and leave both out to start a new copy.",
        )
        .openapi({ param: { name: "X-Marfa-Reach", in: "header" } }),
      "Last-Event-ID": z
        .string()
        .optional()
        .describe(
          "The ID of the last event you received. Marfa replays every event after it that the log still holds, then goes live. Send it as the stream wrote it. Empty means none, except on a copy stream.",
        )
        .openapi({ param: { name: "Last-Event-ID", in: "header" } }),
    }),
  },
  responses: {
    200: {
      description:
        "Returns the stream. Each frame's `event:` names it:\n- `stream_cursor`: first, where the log stands.\n- An event, such as `item.created`, with its event ID as `id:`.\n- `stream_live`: once the catch-up is over.\n- `stream_incomplete`, `catchup_too_old`, `cursor_ahead` or `reach_changed`: last, before the stream closes.",
      content: {
        "text/event-stream": {
          schema: { $ref: "#/components/schemas/EventStreamFrame" },
          example: STREAM_EXAMPLE,
        },
      },
    },
    400: {
      description:
        "- `validation_error`: a parameter or header is invalid, or not one this endpoint takes. For example, `type` has more than 10 entries or is `*`, or `Last-Event-ID` isn't an event ID. A copy stream takes only `copy=1` and `edges=all`, and both resume headers or neither; another stream takes no `X-Marfa-Reach`.\n- `unknown_type`: a `type` entry isn't registered.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error", "unknown_type"]),
        },
      },
    },
    403: {
      description:
        "- `type_not_permitted`: you can't read any type, or a `type` entry names a type you can't read, with no subtype you can.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
    },
    503: {
      description:
        "- `stream_capacity_exhausted`: the instance is serving as many streams as its operator allows. Try again later.\n- `write_contention`: the database was busy, and Marfa couldn't complete the request in time. Nothing changed. Try the request again.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "stream_capacity_exhausted",
            "write_contention",
          ]),
        },
      },
    },
  },
});
