import { Hono } from "hono";
import { platformDrift } from "../storage/platform-drift.js";
import { storedValueScan } from "../storage/stored-value-scan.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";

interface ComponentStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
}

/**
 * How long a component probe may take before this endpoint stops waiting
 * on it and reports what it knows.
 *
 * A liveness answer that waits is not a liveness answer. Both probes below
 * are unbounded by nature: the database probe waits on a held database,
 * and the blob probe is a network round trip. Unbounded, `/health` would
 * not report a busy server but hang on it, while ordinary requests were
 * still being served, and the one endpoint whose job is to say how things
 * are would be the only one that could not say anything.
 *
 * Two seconds is well past a healthy answer (single-digit milliseconds) and
 * well short of any caller's patience.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** Marker for a probe that outran its budget rather than failing. */
const TIMED_OUT = Symbol("probe-timed-out");

/**
 * Race a probe against the budget. A probe that loses keeps running — it
 * holds a handle or a socket we cannot reclaim — so its eventual
 * rejection is swallowed deliberately: it belongs to an answer nobody is
 * waiting for any more, and left unhandled it would be reported as a fault
 * over a health check.
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

/**
 * Placement is stated per environment rather than read from a provider's
 * own variables, because nothing outside that provider sets those and a
 * check keyed on them goes quiet without ever failing. It is reported
 * because getting it wrong produces no error, no failed deploy and no
 * degraded status, only latency against a database that then takes the
 * blame. Unset, the block is absent rather than carrying empty strings
 * that would read as a real answer.
 */
export function healthRoutes(
  storage: Storage,
  blobs: BlobLayer,
  config: Pick<AppConfig, "versionFile" | "placement">,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { versionFile: version, placement } = config;

  router.get("/", async (c) => {
    const components: Record<string, ComponentStatus> = {};
    let overall: "ok" | "degraded" = "ok";

    // Database. `down` and `degraded` are different answers and the
    // difference is the useful part: `down` means the database refused,
    // `degraded` means we could not get an answer inside the budget, which
    // is what a held database looks like from here.
    //
    // Latency rides every branch rather than only the healthy one. A probe
    // that failed after 1.9 seconds and one that failed in 5ms are different
    // faults, and the branch that reported no number was the one where the
    // number said most. On the timed-out branch it is the budget by
    // construction, which is worth publishing anyway: a watcher graphing this
    // sees the climb and then the cap rather than a gap.
    const dbStart = performance.now();
    try {
      const outcome = await withBudget(storage.keys.count());
      const latencyMs = Math.round(performance.now() - dbStart);
      if (outcome === TIMED_OUT) {
        components.database = {
          status: "degraded",
          latency_ms: latencyMs,
          error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms — the database may be held`,
        };
      } else {
        // The probe answered, and that is the whole question this component
        // asks.
        components.database = { status: "ok", latency_ms: latencyMs };
      }
    } catch (err) {
      components.database = {
        status: "down",
        latency_ms: Math.round(performance.now() - dbStart),
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.database.status !== "ok") overall = "degraded";

    // Blob storage. The disk store, which every upload lands on, under the
    // same budget: a held disk is a fault this door exists to report.
    const blobStart = performance.now();
    try {
      const outcome = await withBudget(blobs.disk.has("sha256:healthcheck"));
      // Latency on every branch, for the reason the database probe gives
      // above: this is the other bounded probe, and a blob store that
      // refused after most of its budget is a different fault from one that
      // refused at once.
      const blobLatencyMs = Math.round(performance.now() - blobStart);
      components.blob_storage =
        outcome === TIMED_OUT
          ? {
              status: "degraded",
              latency_ms: blobLatencyMs,
              error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms`,
            }
          : { status: "ok", latency_ms: blobLatencyMs };
    } catch (err) {
      components.blob_storage = {
        status: "down",
        latency_ms: Math.round(performance.now() - blobStart),
        error: err instanceof Error ? err.message : "unknown",
      };
    }
    if (components.blob_storage.status !== "ok") overall = "degraded";

    // Shipped types this instance still carries that the build no longer
    // names. Derived at boot from the build and the rows, so reading it
    // costs nothing and cannot go stale against a running process.
    //
    // A count and nothing else: this endpoint is unauthenticated, and the
    // identifiers say
    // which types an instance is serving that its build does not. Those
    // sit behind the admin read.
    //
    // Not a component: it carries no status and never degrades the
    // response. Neither kind of drift is a fault. A retired type that still holds
    // items is the designed outcome, because the row is what makes those
    // items resolve, and the removal route refuses to drop it. A retired
    // type holding nothing is untidy rather than unhealthy: it resolves,
    // it serves, it costs nothing. Overall status answers whether this
    // instance is serving correctly right now, and a row that changes no
    // behavior is not part of that answer. A component that can sit
    // degraded indefinitely teaches its readers to ignore the ones that
    // matter, so the rule: a check earns the right to degrade only if
    // something is wrong now. If the honest description is "someone could
    // tidy this up", it is a report.
    const platformTypes = { drifted: platformDrift().length };

    // How many rows this instance holds whose stored value falls outside
    // the union the build compares that column against. Counted at boot,
    // so reading it costs nothing and cannot go stale against a running
    // process.
    //
    // A count and nothing else, and here that is sharper than it is for
    // the drift figure above: this endpoint is unauthenticated, and the
    // value itself would advertise what another build wrote to anyone who
    // asks. The true stored string is on the boot log, behind the
    // operator's access to it.
    //
    // Not a component, and this is the shape decision rather than the
    // field. It carries no status and never moves `overall`, which is
    // `platform_types`'s shape. The
    // rule is already written into this file: a check earns the right to
    // degrade only if something is wrong now. This one can sit non-zero
    // indefinitely (clearing it needs the build that wrote the rows or a
    // hand `UPDATE` on somebody's schedule, not a button) and a component that can sit
    // degraded indefinitely teaches its readers to ignore the ones that
    // matter. The severity lives on the boot log, which is `error`-level
    // and names the table, the column, the true stored string and the
    // count.
    //
    // Rows rather than distinct values: "how many rows" is the question
    // that matters, and it is what tells one
    // restored row from a whole table.
    //
    // `scanned` is here because zero rows has three meanings and this is
    // one number over all of them: nothing recorded yet, nothing found,
    // and looked-but-could-not-read. The third is reachable and is the
    // scenario the whole feature exists for: a build meeting a database
    // another build wrote fails on a column one of them does not have, the
    // scan's catch fires, and without this field the endpoint would serve
    // exactly what a healthy instance serves. It carries no identifier, so it does
    // not touch the reason the values themselves stay off an
    // unauthenticated endpoint.
    //
    // It still never moves `overall`. A scan that could not run is not the
    // instance failing to serve, and the rule this block already follows
    // says a check earns the right to degrade only if something is wrong
    // now.
    const scan = storedValueScan();
    const storedValues = {
      rows: scan.values.reduce((sum, v) => sum + v.count, 0),
      scanned: scan.scanned,
    };

    return c.json({
      status: overall,
      components,
      platform_types: platformTypes,
      unrecognized_stored_values: storedValues,
      ...(placement && { placement }),
      ...(version && { version }),
    });
  });

  return router;
}
