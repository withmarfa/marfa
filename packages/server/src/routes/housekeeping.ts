import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireOperatorKey } from "../middleware/auth.js";
import type { Housekeeping } from "../housekeeping/scheduler.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OutcomeSchema = z.enum(["ok", "error"]);

const HousekeepingJobSchema = z.object({
  name: z.string(),
  interval_ms: z.number().int(),
  next_run_at: z.string(),
  running_since: z.string().nullable(),
  last_started_at: z.string().nullable(),
  last_finished_at: z.string().nullable(),
  last_outcome: OutcomeSchema.nullable(),
  last_error: z.string().nullable(),
  last_result: z.unknown().nullable(),
});

const HousekeepingRunSchema = z.object({
  name: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  outcome: OutcomeSchema,
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});

const NameParam = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe("The job's name, as `GET /housekeeping` lists it."),
});

const operatorResponses = {
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
    description: "Operator key required",
  },
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listHousekeepingRoute = createRoute({
  operationId: "listHousekeeping",
  method: "get",
  path: "/",
  tags: ["Housekeeping"],
  summary: "List the instance's housekeeping jobs",
  description:
    "Every periodic job the server runs on itself, with its cadence, when it is next due, whether a run holds it now, and what its last run did. A job disabled by configuration is not listed. Operator key only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(HousekeepingJobSchema) }),
        },
      },
      description: "The jobs",
    },
    ...operatorResponses,
  },
});

const runHousekeepingRoute = createRoute({
  operationId: "runHousekeeping",
  method: "post",
  path: "/{name}/run",
  tags: ["Housekeeping"],
  summary: "Run one housekeeping job now",
  description:
    "Runs the job inline and answers what it did, including a failure, which is reported as the run's `outcome` rather than as this door's. A job never overlaps itself: one in the middle of a run answers `409`. Operator key only.",
  security: [{ bearerAuth: [] }],
  request: { params: NameParam },
  responses: {
    200: {
      content: { "application/json": { schema: HousekeepingRunSchema } },
      description: "The run",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Not a job name",
    },
    ...operatorResponses,
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["housekeeping_job_not_found"]),
        },
      },
      description: "No such job on this instance",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["housekeeping_job_running"]),
        },
      },
      description: "A run holds the job",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function housekeepingRoutes(housekeeping: Housekeeping) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listHousekeepingRoute, async (c) => {
    requireOperatorKey(c);
    const data = await housekeeping.list();
    return c.json({ data }, 200);
  });

  router.openapi(runHousekeepingRoute, async (c) => {
    requireOperatorKey(c);
    const { name } = c.req.valid("param");
    const result = await housekeeping.runNow(name);
    if (result.kind === "unknown") {
      throw new MarfaError(
        ErrorCode.HOUSEKEEPING_JOB_NOT_FOUND,
        `This instance runs no housekeeping job named ${name}`,
      );
    }
    if (result.kind === "running") {
      throw new MarfaError(
        ErrorCode.HOUSEKEEPING_JOB_RUNNING,
        `${name} is in the middle of a run`,
      );
    }
    return c.json(result.run, 200);
  });

  return router;
}
