import { createRoute, z } from "@hono/zod-openapi";
import { ALL_TYPES } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { standingPermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import * as clock from "../clock.js";
import type { AppConfig } from "../config.js";
import { figuresFor, readProcessFigures } from "../instance-figures.js";

const CACHE_TTL_MS = 60_000;

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
        .nullable()
        .describe(
          "Memory the server process holds in RAM, in bytes. `null` if it can't be read.",
        ),
      memory_rss_peak_bytes: z
        .number()
        .nullable()
        .describe(
          "The most memory the process has held in RAM, in bytes. `null` if it can't be read.",
        ),
      heap_used_bytes: z
        .number()
        .nullable()
        .describe(
          "Memory the JavaScript engine uses for live objects, in bytes. `null` if it can't be read.",
        ),
      heap_total_bytes: z
        .number()
        .nullable()
        .describe(
          "Memory the JavaScript engine has reserved, in bytes. `null` if it can't be read.",
        ),
      cpu_user_seconds: z
        .number()
        .nullable()
        .describe(
          "CPU seconds the process has spent on its own work since it started. `null` if it can't be read.",
        ),
      cpu_system_seconds: z
        .number()
        .nullable()
        .describe(
          "CPU seconds the process has spent in the operating system since it started. `null` if it can't be read.",
        ),
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
          "Row counts of the largest tables, as of `counted_at`. `null` if a count can't be read, and all `null` until the first count finishes.",
        ),
      counted_at: z
        .string()
        .nullable()
        .describe(
          "When the row counts were taken, in UTC. `null` until the first count finishes. A request never counts: when there is no count or it is over an hour old, Marfa starts one in the background.",
        ),
    })
    .describe("Database size and row counts."),
  cached_at: z
    .string()
    .describe(
      "When the item, blob, type, key and webhook counters were collected, in UTC. They are reused for up to a minute. The `process` and `storage` blocks are read on each request.",
    ),
});

// Every admitted caller sees the same instance-wide counters. The cache holds
// the ones read live; the process and storage blocks are built per request.
type LiveCounters = Pick<
  z.infer<typeof MetricsResponseSchema>,
  "items" | "blobs" | "types" | "keys" | "webhooks" | "cached_at"
>;
interface CacheEntry {
  counters: LiveCounters;
  at: number;
}
let liveCache: CacheEntry | undefined;

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
  const release = config.versionSha ?? "dev";
  const keeper = figuresFor(storage, config.sqlitePath, release);
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getMetricsRoute, async (c) => {
    // A request never counts the big tables: it reads the last count as it
    // stands now and starts a background count when that is missing or old.
    const counts = keeper.last();
    keeper.refreshInBackground();

    const now = clock.monotonicMs();
    if (!liveCache || now - liveCache.at >= CACHE_TTL_MS) {
      const [
        itemStats,
        blobStats,
        keyCount,
        webhookCount,
        registeredTypeCount,
      ] = await Promise.all([
        storage.items.stats({ all_states: true }),
        storage.blobs.count(),
        storage.keys.count(),
        storage.outboundWebhooks.count(),
        storage.types.countRegistered(),
      ]);
      const total = Object.values(itemStats).reduce((a, b) => a + b, 0);
      liveCache = {
        at: now,
        counters: {
          items: { total, by_state: itemStats },
          blobs: {
            count: blobStats.count,
            total_bytes: blobStats.total_size_bytes,
          },
          types: { core: ALL_TYPES.length, registered: registeredTypeCount },
          keys: { total: keyCount },
          webhooks: { total: webhookCount },
          cached_at: clock.now().toISOString(),
        },
      };
    }

    const p = readProcessFigures(release);
    const files = await keeper.files();

    return c.json(
      {
        ...liveCache.counters,
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
          ...files,
          rows: {
            items: counts?.items ?? null,
            versions: counts?.versions ?? null,
            event_log: counts?.event_log ?? null,
            audit_log: counts?.audit_log ?? null,
          },
          counted_at: counts?.counted_at ?? null,
        },
      },
      200,
    );
  });

  return router;
}
