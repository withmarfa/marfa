import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { operatorOnly } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

// A single module-level cache is sufficient: the platform gate refuses
// working credentials, so every caller that reaches the handler sees
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
    registered: z.number(),
  }),
  keys: z.object({
    total: z.number(),
  }),
  webhooks: z.object({
    total: z.number(),
  }),
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
    "Instance-wide counters for items, blobs, types, keys, and webhooks, plus process uptime. `keys.total` counts unrevoked keys. Operator key only: the counters are instance-wide rather than permission-scoped.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
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
