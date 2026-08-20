/**
 * Local integrations runtime — public entry point.
 *
 * The in-process integrations substrate: backed by Postgres (`pg-boss`
 * for cron + queue) and `worker_thread` per-Integration handler pools.
 *
 * Surface:
 *   - `tryStartLocalIntegrationRuntime` — call from `index.ts`. Returns
 *     a `LocalRuntimeBundle` carrying the supervisor + bridge + a Hono
 *     sub-app exposing `POST /runtime/webhook/:connection_id`; throws
 *     rather than starting without Postgres.
 *   - `loadInTreeRegistrations` — bootstraps the in-tree integration
 *     registrations from per-integration `local.ts` entries. Called by
 *     `tryStartLocalIntegrationRuntime` when running inside the server
 *     bundle. Tests build their own `LocalIntegrationRegistration[]`
 *     and call `createSupervisor` directly.
 */
import { Hono } from "hono";
import type { AppConfig } from "../../config.js";
import type { Storage } from "../../storage/interface.js";
import { createExecutor } from "./executor.js";
import {
  createLocalReactiveBridge,
  type LocalBridgeRuntime,
} from "./reactive-bridge.js";
import { createSupervisor } from "./supervisor.js";
import { createDeadLetterOps, type DeadLetterOps } from "./dead-letters.js";
import type { PgDb } from "../../storage/pg/connection.js";
import type { PgBoss } from "pg-boss";
import type { LocalIntegrationRegistration, LocalRuntime } from "./types.js";
import { registerWebhookReceiptRoute } from "./webhook-receipt.js";

export type {
  LocalIntegrationRegistration,
  LocalRuntime,
  SchedulerEnvelope,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
  DirectDispatchFn,
} from "./types.js";
export { createSupervisor } from "./supervisor.js";
export { createExecutor } from "./executor.js";
export { createLocalReactiveBridge } from "./reactive-bridge.js";
export { registerWebhookReceiptRoute } from "./webhook-receipt.js";
export { mintLocalRuntimeCredential } from "./credentials.js";
export {
  readConnectionRuntimeState,
  applyCursorDelta,
  recordRuntimeError,
  checkAndRecordIdempotency,
  CONNECTION_RUNTIME_NAMESPACE,
  CONNECTION_IDEMPOTENCY_NAMESPACE,
} from "./pg-cursor-store.js";
export { fanOutSchedule } from "./walker.js";
export { loadInTreeRegistrations } from "./registrations.js";

export interface LocalRuntimeBundle {
  runtime: LocalRuntime;
  bridge: LocalBridgeRuntime;
  app: Hono;
  /**
   * Operator surface over the substrate's dead-lettered dispatches
   * (list + replay). `null` when no real pg-boss backs the runtime
   * (tests driving `dispatchForTest`) — the admin routes then answer
   * 503 `local_runtime_not_available`.
   */
  deadLetterOps: DeadLetterOps | null;
}

export interface StartLocalRuntimeOptions {
  storage: Storage;
  config: AppConfig;
  /** Public Marfa API URL the in-thread `ConnectionClient` hits.
   *  Defaults to `http://localhost:<config.port>` if unset. */
  apiUrl?: string;
  /** Production deployments pass the in-tree integration registrations
   *  built by `loadInTreeRegistrations`. Tests pass hand-crafted ones
   *  that exercise the substrate without spawning worker threads. */
  registrations: LocalIntegrationRegistration[];
  /** Boss-side hook. Production sets up a real pg-boss instance; tests
   *  pass `null` and drive dispatches via `dispatchForTest`. */
  boss: PgBoss | null;
  /**
   * Whether this process executes dispatches. `false` is the web role's
   * enqueue-only shape: the webhook receipt route, the dead-letter admin
   * surface, and the reactive bridge's enqueue side all stay, but no
   * queue workers register and no schedule crons seed, so handler code
   * runs only in the worker role. Defaults to `true`.
   */
  dispatch?: boolean;
}

/**
 * Build and start the local runtime bundle. Returns the bundle so the
 * caller can stop it on shutdown.
 *
 * Throws on `DB_DIALECT=sqlite`: the runtime requires Postgres
 * (advisory locks + pg-boss schema), so the caller gates on dialect
 * and skips integrations entirely on SQLite.
 */
export async function tryStartLocalIntegrationRuntime(
  options: StartLocalRuntimeOptions,
): Promise<LocalRuntimeBundle> {
  const { storage, config } = options;
  if (config.storageDialect !== "pg") {
    throw new Error(
      "The integration runtime requires DB_DIALECT=pg. " +
        "SQLite deployments run without integrations until they migrate to Postgres.",
    );
  }

  const apiUrl = options.apiUrl ?? `http://localhost:${String(config.port)}`;
  const executor = createExecutor({
    poolSize: config.integrationWorkerThreads,
  });
  const runtime = createSupervisor(storage, {
    apiUrl,
    apiKeySalt: config.apiKeySalt,
    authMode: config.authMode,
    registrations: options.registrations,
    executor,
    boss: options.boss,
    registerWorkers: options.dispatch !== false,
  });
  await runtime.start();

  const bridge = createLocalReactiveBridge(storage, runtime);
  await bridge.start();

  const app = new Hono();
  registerWebhookReceiptRoute(app, storage, runtime);

  // The listing reads pg-boss's own job table, so it needs both the real
  // boss (replay) and the PG Drizzle handle (raw SQL). Both always exist
  // on a production boot; tests that pass `boss: null` get no ops.
  const deadLetterOps =
    options.boss && storage.pgDb
      ? createDeadLetterOps(options.boss, storage.pgDb as PgDb)
      : null;

  return { runtime, bridge, app, deadLetterOps };
}
