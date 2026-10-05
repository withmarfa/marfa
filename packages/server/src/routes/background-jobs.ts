import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { operatorOnly } from "../middleware/auth.js";
import type { BackgroundJobs } from "../background-jobs/scheduler.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { nullableRef, pageOf } from "./_schemas.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OutcomeSchema = z.enum(["ok", "error"]).openapi("BackgroundJobOutcome");

/**
 * What a run reports.
 *
 * The names differ per job — `deleted`, `purged_records`, `copied`, `bytes`,
 * the heartbeat's `ok` and `status` — so the keys are open; the values are
 * scalars because the scheduler's job contract says so and the compiler
 * holds every registered job to it. Declared rather than left unknown: a
 * report a caller cannot read the type of is one it has to guess at.
 */
const BackgroundJobReportSchema = z
  .record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.null()]))
  .openapi("BackgroundJobReport");

const BackgroundJobSchema = z
  .object({
    name: z.string(),
    interval_ms: z.number().int(),
    next_run_at: z.string(),
    running_since: z.string().nullable(),
    last_started_at: z.string().nullable(),
    last_finished_at: z.string().nullable(),
    last_outcome: nullableRef(OutcomeSchema),
    last_error: z.string().nullable(),
    last_result: nullableRef(BackgroundJobReportSchema),
  })
  .openapi("BackgroundJob");

const BackgroundJobRunSchema = z
  .object({
    name: z.string(),
    started_at: z.string(),
    finished_at: z.string(),
    outcome: OutcomeSchema,
    result: nullableRef(BackgroundJobReportSchema),
    error: z.string().nullable(),
  })
  .openapi("BackgroundJobRun");

const NameParam = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe("The background job's name, as `GET /background-jobs` lists it."),
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
    description: "- `forbidden`: your key isn't an operator key.",
  },
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listBackgroundJobsRoute = createRoute({
  operationId: "listBackgroundJobs",
  method: "get",
  path: "/",
  tags: ["Instance"],
  summary: "List background jobs",
  description:
    "Returns every background job Marfa runs on itself: its interval, when it's next due, whether a run holds it, and what its last run did. One turned off by configuration isn't listed, unless `/config` can turn it back on. Operator key only.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(BackgroundJobSchema, "BackgroundJobPage"),
        },
      },
      description: "Returns every background job, in one page.",
    },
    ...operatorResponses,
  },
});

const runBackgroundJobRoute = createRoute({
  operationId: "runBackgroundJob",
  method: "post",
  path: "/{name}/run",
  tags: ["Instance"],
  summary: "Run a background job",
  description:
    "Runs a background job now, waits for it to finish, and returns what the run did. A failed run still returns `200`, with the failure in `outcome` and `error`. Operator key only.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  request: { params: NameParam },
  responses: {
    200: {
      content: { "application/json": { schema: BackgroundJobRunSchema } },
      description: "Returns the run.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: `name` isn't lowercase letters, digits and hyphens starting with a letter, or a query parameter is unknown.",
    },
    ...operatorResponses,
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["background_job_not_found"]),
        },
      },
      description:
        "- `background_job_not_found`: this instance runs no background job with this name.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["background_job_running"]),
        },
      },
      description:
        "- `background_job_running`: the background job is already running. Try again when the run finishes.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function backgroundJobRoutes(backgroundJobs: BackgroundJobs) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listBackgroundJobsRoute, async (c) => {
    const data = await backgroundJobs.list();
    return c.json({ data, next_cursor: null }, 200);
  });

  router.openapi(runBackgroundJobRoute, async (c) => {
    const { name } = c.req.valid("param");
    const result = await backgroundJobs.runNow(name);
    if (result.kind === "unknown") {
      throw new MarfaError(
        ErrorCode.BACKGROUND_JOB_NOT_FOUND,
        `This instance runs no background job named ${name}`,
      );
    }
    if (result.kind === "running") {
      throw new MarfaError(
        ErrorCode.BACKGROUND_JOB_RUNNING,
        `${name} is in the middle of a run`,
      );
    }
    return c.json(result.run, 200);
  });

  return router;
}
