import { createRoute, z } from "@hono/zod-openapi";
import { Hono, type Context } from "hono";
import { ErrorCode } from "@withmarfa/shared";
import { shapedError } from "../middleware/error-handler.js";
import { retiredPlatformTypes } from "../storage/retired-platform-types.js";
import { storedValueScan } from "../storage/stored-value-scan.js";
import type { AppConfig } from "../config.js";
import { hashApiKey, type AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { refuseUndeclaredQueryKeys } from "../middleware/undeclared-query-keys.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import {
  DISK_DEGRADED_BELOW_BYTES,
  DISK_DOWN_BELOW_BYTES,
  type HealthProbes,
} from "./health-probes.js";
import { errorReason } from "../error-text.js";
import { makeErrorResponseSchema } from "../openapi.js";

export type Status = "ok" | "degraded" | "down";

export interface ComponentStatus {
  status: Status;
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
async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number = PROBE_TIMEOUT_MS,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolveBudget) => {
    timer = setTimeout(() => {
      resolveBudget(TIMED_OUT);
    }, budgetMs);
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
 * Whether a stored key holds instance.read, read from the key
 * table alone. It is not the credential middleware: that one stamps the
 * key as used, which is a write, and this door is asked precisely when
 * writes may be failing. A database that cannot look the key up says no.
 */
export function instanceReadCaller(
  storage: Pick<Storage, "keys">,
  salt: string,
): (authorization: string | undefined) => Promise<boolean> {
  return async (authorization) => {
    if (!authorization?.startsWith("Bearer ")) return false;
    try {
      const key = await storage.keys.validate(
        hashApiKey(authorization.slice(7), salt),
      );
      return key?.permissions.includes("instance.read") === true;
    } catch {
      return false;
    }
  };
}

/**
 * One probe under the budget. `down` is a refusal, `degraded` is no answer
 * in time, and latency rides both for the reason `database` gives above.
 *
 * A write refused because another write held the lock past the busy budget
 * is no answer either: the lock is held, as it is for the whole of an archive
 * restore, and the next write after it lands. The refusal arrives wrapped by
 * the query layer.
 */
async function timed(
  work: () => Promise<unknown>,
  heldMessage: string,
  budgetMs: number = PROBE_TIMEOUT_MS,
): Promise<ComponentStatus> {
  const started = performance.now();
  try {
    const outcome = await withBudget(work(), budgetMs);
    const latencyMs = Math.round(performance.now() - started);
    return outcome === TIMED_OUT
      ? { status: "degraded", latency_ms: latencyMs, error: heldMessage }
      : { status: "ok", latency_ms: latencyMs };
  } catch (err) {
    const held = shapedError(err)?.code === ErrorCode.WRITE_CONTENTION;
    return {
      status: held ? "degraded" : "down",
      latency_ms: Math.round(performance.now() - started),
      error: describe(err),
    };
  }
}

/** What went wrong: a database failure in its fixed form with its SQLite
 *  code, and the wrapped error of anything else that wraps one. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  return errorReason(err);
}

async function diskComponent(
  probes: HealthProbes,
  reserveBytes: number,
): Promise<ComponentStatus> {
  // Below the reserve every upload and restore is refused, so the instance
  // is no longer fully serving, whatever the fixed line says.
  const degradedBelow = Math.max(DISK_DEGRADED_BELOW_BYTES, reserveBytes);
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    const available = await withBudget(probes.availableBytes());
    if (available === TIMED_OUT) {
      return {
        status: "degraded",
        latency_ms: latency(),
        error: `no answer within ${String(PROBE_TIMEOUT_MS)}ms`,
      };
    }
    if (available < DISK_DOWN_BELOW_BYTES) {
      return {
        status: "down",
        latency_ms: latency(),
        error: `${String(available)} bytes available, below ${String(DISK_DOWN_BELOW_BYTES)}`,
      };
    }
    if (available < degradedBelow) {
      return {
        status: "degraded",
        latency_ms: latency(),
        error: `${String(available)} bytes available, below ${String(degradedBelow)}`,
      };
    }
    return { status: "ok", latency_ms: latency() };
  } catch (err) {
    return {
      status: "degraded",
      latency_ms: latency(),
      error: `free space unknown: ${describe(err)}`,
    };
  }
}

/** What the machine and its stores answer right now, and the worst of it. */
export interface HealthReading {
  status: Status;
  components: Record<string, ComponentStatus>;
}

/**
 * Asks each component and gives the worst answer. `GET /health` and the
 * owner console's Health page read the instance through this one function,
 * so they cannot disagree about what is down.
 */
export async function readHealth(
  storage: Pick<Storage, "keys">,
  blobs: Pick<BlobLayer, "disk">,
  config: Pick<AppConfig, "diskReserveBytes">,
  probes: HealthProbes,
): Promise<HealthReading> {
  const components: Record<string, ComponentStatus> = {};

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
  const database = timed(
    () => storage.keys.count(),
    `no answer within ${String(PROBE_TIMEOUT_MS)}ms — the database may be held`,
  );

  // A committed write, because a database that reads can still refuse
  // every write: a volume remounted read-only, a disk that is full, a log
  // that cannot grow. Under the same budget, since a write queues behind
  // the writes ahead of it.
  const databaseWrite = timed(
    () => probes.write(),
    `no write committed within ${String(PROBE_TIMEOUT_MS)}ms — the database may be held`,
  );

  // Room to write into. Unknown is not down: a volume the probe could not
  // read says so as `degraded`, and only a measured shortage is `down`.
  const disk = diskComponent(probes, config.diskReserveBytes ?? 0);

  // Blob storage. The disk store, which every upload lands on, under the
  // same budget: a held disk is a fault this door exists to report.
  const blobStorage = timed(
    () => blobs.disk.has("sha256:healthcheck"),
    `no answer within ${String(PROBE_TIMEOUT_MS)}ms`,
  );

  [
    components.database,
    components.database_write,
    components.disk,
    components.blob_storage,
  ] = await Promise.all([database, databaseWrite, disk, blobStorage]);

  const statuses = Object.values(components).map((one) => one.status);
  const overall: Status = statuses.includes("down")
    ? "down"
    : statuses.includes("degraded")
      ? "degraded"
      : "ok";

  return { status: overall, components };
}

/**
 * The attached object store, asked the same way, or `null` when the instance
 * has none. `GET /health` leaves it out: it reports the disk store every
 * upload lands on.
 */
export function objectStoreComponent(
  blobs: Pick<BlobLayer, "s3">,
  budgetMs: number = PROBE_TIMEOUT_MS,
): Promise<ComponentStatus | null> {
  const store = blobs.s3;
  if (store === null) return Promise.resolve(null);
  return timed(
    () => store.has("sha256:healthcheck"),
    `no answer within ${String(budgetMs)}ms`,
    budgetMs,
  );
}

const StatusSchema = z
  .enum(["ok", "degraded", "down"])
  .describe(
    "`ok`: serving normally. `degraded`: serving, but something is slow, low or unknown. `down`: something refused.",
  );

const ComponentStatusSchema = z
  .object({
    status: StatusSchema,
    latency_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How long the check took, in milliseconds."),
    error: z
      .string()
      .optional()
      .describe(
        "What went wrong. Present only for a caller that holds `instance.read`.",
      ),
  })
  .describe("One component's state.");

export const HealthSchema = z
  .object({
    status: StatusSchema,
    components: z
      .object({
        database: ComponentStatusSchema.describe(
          "Whether the database answers a read.",
        ),
        database_write: ComponentStatusSchema.describe(
          "Whether the database commits a write.",
        ),
        disk: ComponentStatusSchema.describe(
          "Whether the disk has room to write.",
        ),
        blob_storage: ComponentStatusSchema.describe(
          "Whether the blob store on disk answers.",
        ),
      })
      .describe(
        "Each component checked: reading and writing the database, free disk space and the blob store.",
      ),
    platform_types: z
      .object({
        retired: z
          .number()
          .int()
          .min(0)
          .describe(
            "How many platform types the instance holds that this build no longer ships.",
          ),
      })
      .describe("The platform types this build no longer ships."),
    unrecognized_stored_values: z
      .object({
        rows: z
          .number()
          .int()
          .min(0)
          .describe(
            "How many stored rows hold a value this build does not recognize.",
          ),
        scanned: z
          .boolean()
          .describe(
            "`true` if the scan for such rows ran. `false` means `rows` is unknown.",
          ),
      })
      .describe("Stored values this build does not recognize."),
    placement: z
      .object({
        region: z
          .string()
          .optional()
          .describe("The region the server runs in."),
        location: z
          .string()
          .optional()
          .describe("The location the server runs in."),
        country: z
          .string()
          .optional()
          .describe("The country the server runs in."),
      })
      .optional()
      .describe("Where the server runs. Present only when it is configured."),
    version: z
      .string()
      .optional()
      .describe("The build the instance runs, when it is known."),
  })
  .describe(
    "The instance's health: the worst state of its components, and each one's state.",
  )
  .openapi("Health", {
    example: {
      status: "ok",
      components: {
        database: { status: "ok", latency_ms: 1 },
        database_write: { status: "ok", latency_ms: 2 },
        disk: { status: "ok", latency_ms: 0 },
        blob_storage: { status: "ok", latency_ms: 0 },
      },
      platform_types: { retired: 0 },
      unrecognized_stored_values: { rows: 0, scanned: true },
    },
  });

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tags: ["Health and maintenance"],
  summary: "Get the instance's health",
  description:
    "Returns whether the instance is serving and the state of each component it depends on. Needs no credential.",
  responses: {
    200: {
      description: "Returns the health. `status` is `ok` or `degraded`.",
      content: { "application/json": { schema: HealthSchema } },
    },
    400: {
      description:
        "- `validation_error`: the query has a parameter this endpoint doesn't take.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    503: {
      description:
        "Returns the health when `status` is `down`: a component refused.",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

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
  config: Pick<AppConfig, "versionFile" | "placement" | "diskReserveBytes">,
  probes: HealthProbes,
  /** Read-only authority resolution; health must remain available when writes fail. */
  mayReadDetails: (c: Context<AppEnv>) => Promise<boolean> = () =>
    Promise.resolve(false),
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { versionFile: version, placement } = config;

  router.get("/", refuseUndeclaredQueryKeys([]), async (c) => {
    const { status: overall, components } = await readHealth(
      storage,
      blobs,
      config,
      probes,
    );

    // The text of an error is the database's or the operating system's own,
    // and carries paths and driver detail. This door takes no credential,
    // so only a holder of instance.read is told it.
    if (!(await mayReadDetails(c))) {
      for (const component of Object.values(components)) {
        delete component.error;
      }
    }

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
    // response. Neither kind of retired type is a fault. A retired type that still holds
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
    const platformTypes = { retired: retiredPlatformTypes().length };

    // How many rows this instance holds whose stored value falls outside
    // the union the build compares that column against. Counted at boot,
    // so reading it costs nothing and cannot go stale against a running
    // process.
    //
    // A count and nothing else, and here that is sharper than it is for
    // the retired figure above: this endpoint is unauthenticated, and the
    // value itself would advertise what another build wrote to anyone who
    // asks. The true stored string is on the boot log, behind the
    // machine administrator's access to it.
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

    return c.json(
      {
        status: overall,
        components,
        platform_types: platformTypes,
        unrecognized_stored_values: storedValues,
        ...(placement && { placement }),
        ...(version && { version }),
      },
      // A deploy gate and a container's health check read the status code.
      // `degraded` is still serving, so it still answers 200; only `down`
      // is a failure.
      overall === "down" ? 503 : 200,
    );
  });

  return router;
}
