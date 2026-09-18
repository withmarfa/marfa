import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES, ALL_INTEGRATION_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireOperatorKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { scheduledJobsReporter } from "../scheduled/job-metrics.js";
import { log } from "../middleware/logger.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

// A single module-level cache is sufficient: the platform gate refuses
// space-bound credentials, so every caller that reaches the handler sees
// the same instance-wide counts.
interface CacheEntry {
  response: Record<string, unknown>;
  at: number;
}
let metricsCache: CacheEntry | undefined;

const MetricsResponseSchema = z.object({
  items: z.object({
    total: z.number(),
    by_state: z.record(z.string(), z.number()),
  }),
  blobs: z.object({
    count: z.number(),
    total_bytes: z.number(),
  }),
  types: z.object({
    core: z.number(),
    integration: z.number(),
    custom: z.number(),
  }),
  keys: z.object({
    total: z.number(),
  }),
  webhooks: z.object({
    total: z.number(),
  }),
  // Absent, not empty, where there is no queue substrate. A scheduled job
  // logs at info only when its tick changed something, so on a quiet estate
  // silence means either "nothing to do" or "this has not run since boot"
  // and nothing tells them apart; the enrichment sweep was believed stuck
  // for three days on that ambiguity. The rows behind this were always in
  // pg-boss — the missing part was reading them without a psql session. On
  // SQLite the jobs run on in-process timers and write no such record, so
  // the section is omitted rather than reported as a roster of jobs that
  // have never ticked.
  scheduled_jobs: z
    .object({
      window_hours: z.number(),
      jobs: z.array(
        z.object({
          name: z.string(),
          last_completed_at: z.string().nullable(),
          last_queue_failure_at: z.string().nullable(),
          ticks: z.number(),
          slowest_tick_ms: z.number().nullable(),
        }),
      ),
    })
    .optional(),
  uptime_seconds: z.number(),
  cached_at: z.string(),
});

const getMetricsRoute = createRoute({
  operationId: "getServerMetrics",
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Get server metrics",
  description:
    "Instance-wide counters for items, blobs, types, keys, and webhooks, plus process uptime. `keys.total` counts unrevoked keys. `scheduled_jobs` reports one entry per registered background job — its last completed tick, its last queue-level failure, how many ticks finished inside `window_hours`, and the slowest completed one — so a job that ran and found nothing is distinguishable from one that has not run since boot. A registered job with no ticks on record appears with nulls and a zero count rather than being omitted. `last_queue_failure_at` covers the three ways the queue itself gives up on a tick: the tick outran its expiry budget, its process died mid-tick, or its successor send failed and left the chain dead until the repair schedule restored it. It is deliberately not the last time this job's own work failed: every job catches its own error and returns normally, so a tick whose work threw is recorded as a completion and appears in the log rather than here. `slowest_tick_ms` covers completed ticks only, because an abandoned tick stamps its completion at the expiry budget and would read as a long-running one. A job silent for longer than the queue keeps its rows (`deletion_seconds`, seven days by default) has had them deleted and reads the same as one that never ticked; the payload carries no retention horizon, so the two cannot be told apart here. The whole section is absent on a deployment with no queue substrate (SQLite), where the same jobs run on in-process timers and leave no equivalent record. Operator key only: most counters are instance-wide rather than space-scoped, so a credential bound to a space is refused.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MetricsResponseSchema,
        },
      },
      description: "Server metrics",
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
      description: "Caller is not the operator key",
    },
  },
});

export function metricsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    requireOperatorKey(c);

    const now = Date.now();
    if (metricsCache && now - metricsCache.at < CACHE_TTL_MS) {
      return c.json(
        metricsCache.response as z.infer<typeof MetricsResponseSchema>,
        200,
      );
    }

    const reportScheduledJobs = scheduledJobsReporter();

    const [
      itemStats,
      blobStats,
      keyCount,
      webhookCount,
      customTypeCount,
      scheduledJobs,
    ] = await Promise.all([
      storage.items.stats(undefined),
      storage.blobs.count(),
      storage.keys.count(),
      storage.outboundWebhooks.count(),
      storage.types.countCustom(),
      // Installed at boot only where there is a queue to read, which is
      // what makes the section's absence meaningful rather than empty.
      //
      // Caught so one unreadable part does not blind the whole signal. It reads
      // pg-boss's private schema against a caret-ranged dependency, and it
      // outlives the pool by however long a request takes to arrive during
      // a graceful drain, so it has two ways to fail that the counters
      // beside it do not. Making the figures that have been trustworthy
      // for longer hostage to the newest one is the wrong trade on a
      // surface whose whole premise is trustworthiness.
      reportScheduledJobs?.().catch((err: unknown) => {
        log("warn", "Scheduled-job metrics unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }) ?? Promise.resolve(undefined),
    ]);

    const total = Object.values(itemStats).reduce((a, b) => a + b, 0);

    const response = {
      items: {
        total,
        by_state: itemStats,
      },
      blobs: {
        count: blobStats.count,
        total_bytes: blobStats.total_size,
      },
      types: {
        // Counted apart so the number does not quietly conflate the shared
        // vocabulary with the vendor-shaped types an integration writes into.
        core: ALL_TYPES.length,
        integration: ALL_INTEGRATION_TYPES.length,
        custom: customTypeCount,
      },
      keys: {
        total: keyCount,
      },
      webhooks: {
        total: webhookCount,
      },
      ...(scheduledJobs && { scheduled_jobs: scheduledJobs }),
      uptime_seconds: Math.floor((now - startedAt) / 1000),
      cached_at: new Date().toISOString(),
    };

    metricsCache = { response, at: now };

    return c.json(response, 200);
  });

  return router;
}
