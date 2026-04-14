import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

let cachedResponse: Record<string, unknown> | null = null;
let cachedAt = 0;

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
  }),
  webhooks: z.object({
    total: z.number(),
  }),
  uptime_seconds: z.number(),
  cached_at: z.string(),
});

const getMetricsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Get server metrics and statistics",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

export function metricsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    requireAdmin(c);

    const now = Date.now();
    if (cachedResponse && now - cachedAt < CACHE_TTL_MS) {
      return c.json(cachedResponse as z.infer<typeof MetricsResponseSchema>, 200);
    }

    const [itemStats, blobStats, keyCount, webhookCount, customTypeCount] =
      await Promise.all([
        storage.items.stats(c.get("apiKey")?.tenant_id),
        storage.blobs.count(),
        storage.keys.count(),
        storage.webhooks.count(),
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
      },
      webhooks: {
        total: webhookCount,
      },
      uptime_seconds: Math.floor((now - startedAt) / 1000),
      cached_at: new Date().toISOString(),
    };

    cachedResponse = response;
    cachedAt = now;

    return c.json(response, 200);
  });

  return router;
}
