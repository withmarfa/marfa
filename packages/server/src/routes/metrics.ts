import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { standingPermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import * as clock from "../clock.js";
import type { AppConfig } from "../config.js";
import { figuresFor } from "../instance-figures.js";

const CACHE_TTL_MS = 60_000;

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
  keys: MetricCountSchema.describe(
    "Number of keys that haven't been revoked or expired.",
  ),
  webhooks: MetricCountSchema.describe("Number of webhook registrations."),
  uptime_seconds: z
    .number()
    .describe("Seconds since this server process started."),
  process: z
    .object({
      release: z.string().describe("The release this server runs."),
      memory_rss_bytes: z
        .number()
        .describe("Memory the server process holds in RAM, in bytes."),
      memory_rss_peak_bytes: z
        .number()
        .describe("The most memory the process has held in RAM, in bytes."),
      heap_used_bytes: z
        .number()
        .describe(
          "Memory the JavaScript engine uses for live objects, in bytes.",
        ),
      heap_total_bytes: z
        .number()
        .describe("Memory the JavaScript engine has reserved, in bytes."),
      cpu_user_seconds: z
        .number()
        .describe("CPU seconds the process has spent on its own work."),
      cpu_system_seconds: z
        .number()
        .describe("CPU seconds the process has spent in the operating system."),
    })
    .describe("What this server process costs, since it started."),
  storage: z
    .object({
      database_bytes: z
        .number()
        .nullable()
        .describe(
          "Size of the database file, in bytes. `null` if it can't be read.",
        ),
      wal_bytes: z
        .number()
        .nullable()
        .describe(
          "Size of the database's write-ahead log file, in bytes. 0 when there is none. `null` if it can't be read.",
        ),
      rows: z
        .object({
          items: z.number().nullable().describe("Number of items."),
          versions: z
            .number()
            .nullable()
            .describe("Number of stored item versions."),
          event_log: z
            .number()
            .nullable()
            .describe("Number of event log entries."),
          audit_log: z
            .number()
            .nullable()
            .describe("Number of audit log entries."),
        })
        .describe(
          "Row counts of the largest tables. `null` if one can't be read.",
        ),
      counted_at: z
        .string()
        .describe(
          "When the item, blob and row counts were taken, in UTC. Marfa recounts about once an hour.",
        ),
    })
    .describe("Database size and row counts."),
  cached_at: z
    .string()
    .describe("When the other counters were collected, in UTC."),
});

const getMetricsRoute = createRoute({
  operationId: "getInstanceMetrics",
  method: "get",
  path: "/",
  tags: ["Health and maintenance"],
  summary: "Get instance metrics",
  description:
    "Returns instance-wide counters, how much memory, CPU and disk this server uses, and process uptime. Requires `instance.read`; the counters include records outside your content permissions.",
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
      description: "`forbidden`: your credential lacks `instance.read`.",
    },
  },
});

export function metricsRoutes(storage: Storage, config: AppConfig) {
  const keeper = figuresFor(
    storage,
    config.sqlitePath,
    config.versionSha ?? "dev",
  );
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    const now = clock.monotonicMs();
    if (metricsCache && now - metricsCache.at < CACHE_TTL_MS) {
      return c.json(
        metricsCache.response as z.infer<typeof MetricsResponseSchema>,
        200,
      );
    }

    const [figures, keyCount, webhookCount, registeredTypeCount] =
      await Promise.all([
        keeper.read(),
        storage.keys.count(),
        storage.outboundWebhooks.count(),
        storage.types.countRegistered(),
      ]);
    const { process: p, storage: s } = figures;
    if (s.items_by_state === null || s.items === null || s.blobs === null) {
      throw new Error("The item and blob counts could not be read");
    }

    const response = {
      items: {
        total: s.items,
        by_state: s.items_by_state,
      },
      blobs: {
        count: s.blobs,
        total_bytes: s.blob_bytes ?? 0,
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
      uptime_seconds: p.uptime_seconds,
      process: {
        release: p.release,
        memory_rss_bytes: p.rss_bytes,
        memory_rss_peak_bytes: p.rss_peak_bytes,
        heap_used_bytes: p.heap_used_bytes,
        heap_total_bytes: p.heap_total_bytes,
        cpu_user_seconds: p.cpu_user_seconds,
        cpu_system_seconds: p.cpu_system_seconds,
      },
      storage: {
        database_bytes: s.database_bytes,
        wal_bytes: s.wal_bytes,
        rows: {
          items: s.items,
          versions: s.versions,
          event_log: s.event_log,
          audit_log: s.audit_log,
        },
        counted_at: s.counted_at,
      },
      cached_at: clock.now().toISOString(),
    };

    metricsCache = { response, at: now };

    return c.json(response, 200);
  });

  return router;
}
