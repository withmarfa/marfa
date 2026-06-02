import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

// Per-tenant cache. Previously this was a module-level response + timestamp,
// which let one tenant's admin see another tenant's item/blob/etc counts for
// up to CACHE_TTL_MS. Key = tenant_id or a sentinel when the caller's key
// has no tenant_id (single-tenant/keys-mode installs).
interface CacheEntry {
  response: Record<string, unknown>;
  at: number;
}
const NO_TENANT_KEY = "__no_tenant__";
const tenantCache = new Map<string, CacheEntry>();

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
  operationId: "getServerMetrics",
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Get server metrics",
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
  },
});

export function metricsRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    requireAdmin(c);

    const now = Date.now();
    const tenantId = c.get("apiKey")?.tenant_id;
    const cacheKey = tenantId ?? NO_TENANT_KEY;
    const cached = tenantCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return c.json(
        cached.response as z.infer<typeof MetricsResponseSchema>,
        200,
      );
    }

    const [itemStats, blobStats, keyCount, webhookCount, customTypeCount] =
      await Promise.all([
        storage.items.stats(tenantId),
        storage.blobs.count(),
        storage.keys.count(),
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
      },
      webhooks: {
        total: webhookCount,
      },
      uptime_seconds: Math.floor((now - startedAt) / 1000),
      cached_at: new Date().toISOString(),
    };

    tenantCache.set(cacheKey, { response, at: now });

    return c.json(response, 200);
  });

  return router;
}
