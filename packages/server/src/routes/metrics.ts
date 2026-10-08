import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { standingPermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

// Every admitted caller sees the same instance-wide counts.
interface CacheEntry {
  response: Record<string, unknown>;
  at: number;
}
let metricsCache: CacheEntry | undefined;

const MetricCountSchema = z
  .object({ total: z.number().describe("Number of records.") })
  .describe("An instance-wide record count.")
  .openapi("MetricCount");

const MetricsResponseSchema = z.object({
  items: z
    .object({
      total: z.number().describe("Number of items across all states."),
      by_state: z
        .record(z.string(), z.number())
        .describe("Item counts by state."),
    })
    .describe("Instance-wide item counts."),
  blobs: z
    .object({
      count: z.number().describe("Number of stored blobs."),
      total_bytes: z.number().describe("Total size of stored blobs, in bytes."),
    })
    .describe("Stored blob counts and size."),
  types: z
    .object({
      core: z.number().describe("Number of built-in types."),
      registered: z.number().describe("Number of registered types."),
    })
    .describe("Built-in and registered type counts."),
  keys: MetricCountSchema.describe("Number of unrevoked keys."),
  webhooks: MetricCountSchema.describe("Number of webhook registrations."),
  uptime_seconds: z
    .number()
    .describe("Seconds since this server process started."),
  cached_at: z.string().describe("When these counters were collected, in UTC."),
});

const getMetricsRoute = createRoute({
  operationId: "getServerMetrics",
  method: "get",
  path: "/",
  tags: ["Instance"],
  summary: "Get server metrics",
  description:
    "Returns instance-wide counters and process uptime. Requires `instance.read`; the counters include records outside your content permissions.",
  security: [{ bearerAuth: [] }],
  middleware: standingPermission("instance.read"),
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
      description: "Caller lacks instance.read",
    },
  },
});

export function metricsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    const now = Date.now();
    if (metricsCache && now - metricsCache.at < CACHE_TTL_MS) {
      return c.json(
        metricsCache.response as z.infer<typeof MetricsResponseSchema>,
        200,
      );
    }

    const [itemStats, blobStats, keyCount, webhookCount, registeredTypeCount] =
      await Promise.all([
        storage.items.stats({ all_states: true }),
        storage.blobs.count(),
        storage.keys.count(),
        storage.outboundWebhooks.count(),
        storage.types.countRegistered(),
      ]);

    const total = Object.values(itemStats).reduce((a, b) => a + b, 0);

    const response = {
      items: {
        total,
        by_state: itemStats,
      },
      blobs: {
        count: blobStats.count,
        total_bytes: blobStats.total_size_bytes,
      },
      types: {
        core: ALL_TYPES.length,
        registered: registeredTypeCount,
      },
      keys: {
        total: keyCount,
      },
      webhooks: {
        total: webhookCount,
      },
      uptime_seconds: Math.floor((now - startedAt) / 1000),
      cached_at: new Date().toISOString(),
    };

    metricsCache = { response, at: now };

    return c.json(response, 200);
  });

  return router;
}
