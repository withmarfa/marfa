import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES, ALL_INTEGRATION_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { surveyConnectionDrift } from "../connections/auto-upgrade.js";
import { scheduledJobsReporter } from "../scheduled/job-metrics.js";

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
    runtime_credentials: z.object({
      total: z.number(),
      active: z.number(),
    }),
  }),
  // Drift is the number T-709's automatic pass exists to keep at zero, and
  // it had no aggregate surface at all: `previewUpgrade` answers for one
  // connection, so "how much drift is there" was only answerable by
  // iterating by hand. `behind` above zero on a settled deployment means
  // something is waiting on a person, and the two counts below say which.
  connections: z.object({
    live: z.number(),
    behind: z.number(),
    upgradable: z.number(),
    awaiting_consent: z.number(),
    blocked: z.number(),
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
          last_failed_at: z.string().nullable(),
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
    "Instance-wide counters for items, blobs, types, keys, and webhooks, plus process uptime. `keys.total` counts unrevoked keys of every kind; `keys.runtime_credentials` breaks out the machine-minted per-dispatch credentials, whose `total` includes revoked rows still awaiting hard delete and whose `active` excludes anything revoked or past its expiry. `scheduled_jobs` reports one entry per registered background job — its last completed tick, its last failed tick, how many ticks finished inside `window_hours`, and the slowest of them — so a job that ran and found nothing is distinguishable from one that has not run since boot. A registered job with no ticks on record appears with nulls and a zero count rather than being omitted. `last_failed_at` is the last tick the queue itself failed, meaning one that outran its expiry budget or whose process died mid-tick; a tick whose work threw is logged by the job and recorded here as a completion. The whole section is absent on a deployment with no queue substrate (SQLite), where the same jobs run on in-process timers and leave no equivalent record. Platform-admin only: most counters are instance-wide rather than space-scoped, so a credential bound to a space is refused.",
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
      description: "Caller is not a platform admin",
    },
  },
});

export function metricsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    requireAdmin(c);

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
      runtimeCredentialCounts,
      webhookCount,
      customTypeCount,
      drift,
      scheduledJobs,
    ] = await Promise.all([
      storage.items.stats(undefined),
      storage.blobs.count(),
      storage.keys.count(),
      storage.keys.countRuntimeCredentials(new Date().toISOString()),
      storage.outboundWebhooks.count(),
      storage.types.countCustom(),
      surveyConnectionDrift(storage),
      // Installed at boot only where there is a queue to read, which is
      // what makes the section's absence meaningful rather than empty.
      reportScheduledJobs?.() ?? Promise.resolve(undefined),
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
        runtime_credentials: runtimeCredentialCounts,
      },
      connections: drift.summary,
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
