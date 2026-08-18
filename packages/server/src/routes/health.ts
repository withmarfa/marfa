import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OidcProviderHealth } from "../auth/oidc-availability.js";

interface ComponentStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
  /** Per-provider detail, present only on `identity_providers`. */
  providers?: OidcProviderHealth[];
}

/**
 * How long a component probe may take before this endpoint stops waiting
 * on it and reports what it knows.
 *
 * A liveness answer that waits is not a liveness answer. Both probes below
 * are unbounded by nature — the database probe queues for a pool slot, and
 * postgres.js queues an unavailable reservation with no bound at all, while
 * the blob probe is a network round trip. So when the pool was fully held,
 * `/health` did not report a busy server: it never answered, for fifty-two
 * seconds and then a 500, while ordinary requests were still being served.
 * The one endpoint whose job is to say how things are was the only one that
 * could not say anything.
 *
 * Two seconds is well past a healthy answer (single-digit milliseconds) and
 * well short of any caller's patience.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** Marker for a probe that outran its budget rather than failing. */
const TIMED_OUT = Symbol("probe-timed-out");

/**
 * Race a probe against the budget. A probe that loses keeps running — it
 * holds a pool slot or a socket we cannot reclaim — so its eventual
 * rejection is swallowed deliberately: it belongs to an answer nobody is
 * waiting for any more, and an unhandled rejection would take the process
 * down over a health check.
 */
async function withBudget<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolveBudget) => {
    timer = setTimeout(() => {
      resolveBudget(TIMED_OUT);
    }, PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        throw err;
      }),
      budget,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function healthRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
  getAuth?: () => MarfaAuth | undefined,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Read once rather than per request. The file cannot change under a
  // running process — a new build is a new container — and a liveness
  // endpoint should not reach the disk to answer.
  let versionCache: Record<string, unknown> | null | undefined;
  const readVersion = async (): Promise<Record<string, unknown> | null> => {
    if (versionCache !== undefined) return versionCache;
    try {
      const raw = await readFile(
        resolve(process.cwd(), "version.json"),
        "utf-8",
      );
      versionCache = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No version file — normal in development.
      versionCache = null;
    }
    return versionCache;
  };

  router.get("/", async (c) => {
    const components: Record<string, ComponentStatus> = {};
    let overall: "ok" | "degraded" = "ok";

    // Database. `down` and `degraded` are different answers and the
    // difference is the useful part: `down` means the database refused,
    // `degraded` means we could not get an answer inside the budget, which
    // is what pool exhaustion looks like from here.
    const dbStart = performance.now();
    try {
      const outcome = await withBudget(storage.keys.count());
      components.database =
        outcome === TIMED_OUT
          ? {
              status: "degraded",
              error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms — the connection pool may be fully held`,
            }
          : {
              status: "ok",
              latency_ms: Math.round(performance.now() - dbStart),
            };
    } catch (err) {
      components.database = {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.database.status !== "ok") overall = "degraded";

    // Blob storage. Same budget, and the same reason for one: on the
    // hosted deployment this is a network call to object storage.
    const blobStart = performance.now();
    try {
      const outcome = await withBudget(
        blobBackend.exists("sha256:healthcheck"),
      );
      components.blob_storage =
        outcome === TIMED_OUT
          ? {
              status: "degraded",
              error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms`,
            }
          : {
              status: "ok",
              latency_ms: Math.round(performance.now() - blobStart),
            };
    } catch (err) {
      components.blob_storage = {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.blob_storage.status !== "ok") overall = "degraded";

    // Federated identity providers. A provider whose discovery could not
    // be reached degrades rather than taking the server down, so this is
    // the surface that says so — without it the degradation would only
    // be visible in container output, which is the failure mode the rule
    // against silent degradation exists to prevent. Absent entirely when
    // no federated provider is configured. Costs nothing to read: it is a
    // snapshot of an in-process map.
    const providers = getAuth?.()?.oidcHealth() ?? [];
    if (providers.length > 0) {
      const unavailable = providers.filter((p) => p.status === "unavailable");
      components.identity_providers = {
        status: unavailable.length === 0 ? "ok" : "degraded",
        providers,
        ...(unavailable.length > 0 && {
          error: `${String(unavailable.length)} of ${String(providers.length)} unavailable: ${unavailable
            .map((p) => p.provider_id)
            .join(", ")}`,
        }),
      };
      if (unavailable.length > 0) overall = "degraded";
    }

    const version = await readVersion();

    return c.json({
      status: overall,
      auth_mode: config.authMode,
      components,
      ...(version && { version }),
    });
  });

  return router;
}
