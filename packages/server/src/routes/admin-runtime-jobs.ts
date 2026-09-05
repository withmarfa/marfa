/**
 * Platform-admin operator surface over the local integration substrate's
 * dead-lettered dispatches.
 *
 * `GET /admin/runtime/dead-letters` lists dispatches that exhausted their
 * retry ladder — integration, connection, failure reason, attempt count,
 * timestamps — read straight from pg-boss's own job table (no parallel
 * bookkeeping). `POST /admin/runtime/dead-letters/{id}/replay` re-queues
 * exactly one named job via pg-boss's `retry`; a job that is no longer in
 * the failed state (already replayed, running, or completed) is refused
 * with a 409 naming its actual state, so a replay can never run twice.
 *
 * Mounted unconditionally so the OpenAPI reflection sees the routes in
 * every configuration; deployments without the integration runtime
 * (SQLite) answer 503
 * `local_runtime_not_available`. Platform-admin only: dead-letter rows
 * span every space, so a space-bound credential is refused.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../page-limits.js";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { DeadLetterOps } from "../integrations/local-runtime/dead-letters.js";

const DeadLetterJobSchema = z.object({
  id: z.string(),
  integration: z.string(),
  connection_id: z.string(),
  kind: z.string(),
  reason: z.string(),
  attempts: z.number(),
  created_at: z.string(),
  failed_at: z.string().nullable(),
});

const listDeadLettersRoute = createRoute({
  operationId: "adminListDeadLetters",
  method: "get",
  path: "/runtime/dead-letters",
  tags: ["Admin"],
  summary: "List dead-lettered integration dispatches",
  description:
    "Dispatches on the local integration substrate that exhausted their retry ladder, newest failure first. Each row carries the integration and connection the dispatch belonged to, the recorded failure reason, the delivery attempts consumed, and when the job was created and finally failed. Rows age out with the queue's own retention. Platform-admin only. Deployments without the local substrate answer 503.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(MIN_PAGE_LIMIT)
        .max(MAX_PAGE_LIMIT)
        .default(DEFAULT_PAGE_LIMIT)
        .openapi({
          description: "Maximum rows to return (newest failures first).",
        }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ jobs: z.array(DeadLetterJobSchema) }),
        },
      },
      description: "Dead-lettered dispatches, newest failure first",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not a platform admin",
    },
    503: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["local_runtime_not_available"]),
        },
      },
      description: "This deployment runs no local integration substrate",
    },
  },
});

const replayDeadLetterRoute = createRoute({
  operationId: "adminReplayDeadLetter",
  method: "post",
  path: "/runtime/dead-letters/{id}/replay",
  tags: ["Admin"],
  summary: "Replay one dead-lettered dispatch",
  description:
    "Re-queues exactly one named dead-lettered dispatch for one more delivery attempt. Only a job currently in the failed state can be replayed; replaying a job that was already replayed, is running, or has completed is refused with a 409 naming its actual state. A replayed job that fails again returns to the listing and can be replayed again. Platform-admin only. Deployments without the local substrate answer 503.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      // pg-boss job ids are uuids, and its retry SQL casts the parameter
      // to `uuid[]` — validating here turns a malformed id into a clean
      // 400 instead of a database cast error.
      id: z.uuid().openapi({
        description: "Job id from the dead-letter listing.",
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ replayed: z.literal(true), id: z.string() }),
        },
      },
      description: "The job was re-queued for one more attempt",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not a platform admin",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "No job with this id on the dispatch queue",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "The job is not in the failed state",
    },
    503: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["local_runtime_not_available"]),
        },
      },
      description: "This deployment runs no local integration substrate",
    },
  },
});

export function adminRuntimeJobsRoutes(ops: DeadLetterOps | null) {
  const router = createOpenAPIRouter<AppEnv>();

  function requireOps(): DeadLetterOps {
    if (!ops) {
      throw new MarfaError(
        ErrorCode.LOCAL_RUNTIME_NOT_AVAILABLE,
        "This deployment runs no local integration substrate, so there is no dead-letter queue to read",
      );
    }
    return ops;
  }

  router.openapi(listDeadLettersRoute, async (c) => {
    requireAdmin(c);
    const { limit } = c.req.valid("query");
    const jobs = await requireOps().list(limit);
    return c.json({ jobs }, 200);
  });

  router.openapi(replayDeadLetterRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const result = await requireOps().replay(id);
    return c.json(result, 200);
  });

  return router;
}
