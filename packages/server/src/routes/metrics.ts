import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

// A single module-level cache is sufficient: the platform gate refuses
// tenant-bound credentials, so every caller that reaches the handler sees
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
    custom: z.number(),
  }),
  keys: z.object({
    total: z.number(),
    runtime_credentials: z.object({
      total: z.number(),
      active: z.number(),
    }),
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
    "Instance-wide counters for items, blobs, types, keys, and webhooks, plus process uptime. `keys.total` counts unrevoked keys of every kind; `keys.runtime_credentials` breaks out the machine-minted per-dispatch credentials, whose `total` includes revoked rows still awaiting hard delete and whose `active` excludes anything revoked or past its expiry. Platform-admin only: most counters are instance-wide rather than tenant-scoped, so a credential bound to a tenant is refused.",
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

    const [
      itemStats,
      blobStats,
      keyCount,
      runtimeCredentialCounts,
      webhookCount,
      customTypeCount,
    ] = await Promise.all([
      storage.items.stats(undefined),
      storage.blobs.count(),
      storage.keys.count(),
      storage.keys.countRuntimeCredentials(new Date().toISOString()),
      storage.outboundWebhooks.count(),
      storage.types.countCustom(),
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
        core: ALL_TYPES.length,
        custom: customTypeCount,
      },
      keys: {
        total: keyCount,
        runtime_credentials: runtimeCredentialCounts,
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
