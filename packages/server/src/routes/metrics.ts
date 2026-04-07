import { Hono } from "hono";
import { TYPE_REGISTRY } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const CACHE_TTL_MS = 60_000;
const startedAt = Date.now();

let cachedResponse: Record<string, unknown> | null = null;
let cachedAt = 0;

export function metricsRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    requireAdmin(c);

    const now = Date.now();
    if (cachedResponse && now - cachedAt < CACHE_TTL_MS) {
      return c.json(cachedResponse);
    }

    const [itemStats, blobStats, keyCount, webhookCount, customTypeCount] =
      await Promise.all([
        storage.items.stats(c.get("apiKey")?.tenant_id),
        storage.blobs.count(),
        storage.keys.count(),
        storage.webhooks.count(),
        storage.types.countCustom(),
      ]);

    // Core types = total registered minus custom
    const coreTypeCount = TYPE_REGISTRY.size - customTypeCount;

    const response = {
      items: itemStats,
      blobs: {
        count: blobStats.count,
        total_bytes: blobStats.total_size,
      },
      types: {
        core: coreTypeCount,
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

    return c.json(response);
  });

  return router;
}
