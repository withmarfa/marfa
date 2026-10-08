import { serve } from "@hono/node-server";
import { getClaimStatus, issueSetupCode } from "./auth/instance-claim.js";
import { startControlSocket } from "./control/socket.js";
import { bootConfig, setActivePermissionBundles } from "./config.js";
import {
  buildDefaultPermissionBundles,
  resolveAllRegisteredNamespaceRoots,
  resolveRegisteredNamespaceRoots,
} from "./auth/default-bundles.js";
import { setRuntimeNamespaceRoots } from "./auth/oauth-provider.js";
import { createApp } from "./app.js";
import { ensureInstanceId } from "./storage/instance-id.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { setBusyBudgetMs } from "./storage/sqlite/connection.js";
import {
  REFUSED_DATABASE_EXIT_CODE,
  RefusedDatabaseError,
} from "./storage/sqlite/refused-database.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import type { Storage } from "./storage/interface.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { registerHousekeepingJobs } from "./housekeeping/registrations.js";
import { initEventLog } from "./pubsub.js";
import {
  log,
  formatErrorSummary,
  serializeError,
  setLogStacks,
} from "./middleware/logger.js";
import {
  BulkActionWorker,
  setBulkJobEnqueueListener,
} from "./bulk-actions/index.js";
import { shutdownInOrder } from "./shutdown.js";
import { endOpenStreams } from "./routes/open-streams.js";
import { installUnhandledRejectionReporter } from "./process-faults.js";

async function main() {
  installUnhandledRejectionReporter((event, listener) => {
    process.on(event, listener);
  });
  const config = bootConfig();
  setLogStacks(!config.isProduction);
  for (const warning of config.settingWarnings ?? []) log("warn", warning);
  log("info", "Server version", {
    sha: config.versionSha ?? "dev",
    deployed_at: config.versionFile?.deployed_at,
  });

  // Before the first connection opens, because the wrapper reads it on
  // every statement and a budget set afterwards would leave the boot's
  // own writes on the default.
  setBusyBudgetMs(config.sqliteBusyBudgetMs);
  const storage: Storage = await createSqliteStorage(config.sqlitePath);

  const blobs = await createBlobLayer(storage, config);
  log("info", "Blob stores attached", {
    stores: blobs.stores.map((store) => ({
      id: store.id,
      kind: store.kind,
      locator: store.locator,
    })),
  });
  initEventLog(storage.eventLog);

  const housekeeping = new Housekeeping(storage.housekeeping, {
    pollIntervalMs: config.housekeepingPollIntervalMs ?? 1_000,
  });
  registerHousekeepingJobs(housekeeping, storage, blobs, config);

  const bulkActionWorker = new BulkActionWorker({
    storage,
    pollIntervalMs: config.bulkActionPollIntervalMs ?? 500,
    maxPollIntervalMs: config.bulkActionPollMaxIntervalMs ?? 60_000,
    pollBackoffMultiplier: config.bulkActionPollBackoffMultiplier ?? 2,
  });
  // Enqueue wakes the worker. The route cannot hold a worker reference —
  // the app is constructed before the worker exists — so the signal is
  // registered here, where both are in scope. The wake is best-effort on
  // top of the poll loop — the enqueue has already committed, so a lost
  // wake costs latency, never the job.
  setBulkJobEnqueueListener(() => {
    bulkActionWorker.wake();
  });
  if (!config.controlOnly) await bulkActionWorker.start();

  // Admit the runtime custom-namespace roots into the OAuth scope
  // allowlist, before the auth instance is built. Admission only — nothing
  // user-visible: the consent screen derives its roots at render time, and
  // the discovery advertisement is pinned to the baseline. Installed
  // regardless of the bundle override below, because whether a registered
  // namespace is grantable is not the operator's consent-curation lever.
  setRuntimeNamespaceRoots(await resolveAllRegisteredNamespaceRoots(storage));

  // Fold the runtime custom-type namespaces into the active permission
  // bundles, so a custom type under a publisher root is offerable
  // through the default consent set rather than only `user.*`. The
  // operator's override, when set, outranks the derivation.
  const bundles =
    config.permissionBundles ??
    buildDefaultPermissionBundles(
      await resolveRegisteredNamespaceRoots(storage),
    );
  setActivePermissionBundles(bundles);
  config.permissionBundles = bundles;

  // **Minted at first boot**, so an instance holds its name before it has
  // answered anything and before the socket is listening. The root route is
  // handed the value rather than reading it, which is what keeps that one
  // door answerable on an instance whose database has since gone.
  const instanceId = await ensureInstanceId(storage.settings);

  const localApp = createApp(storage, blobs, housekeeping, config, instanceId, {
    localAuthority: true,
  });
  if (!config.controlSocket)
    throw new Error("Private control socket path is missing");
  const control = await startControlSocket(
    config.controlSocket,
    localApp.fetch,
  );
  log("info", "Private control socket listening", {
    path: config.controlSocket,
  });
  if (!(await getClaimStatus(storage)).claimed) {
    const { code } = await issueSetupCode(storage);
    log(
      "warn",
      `Claim this Marfa at /setup with setup code: ${code}`,
      undefined,
      { localOnly: true },
    );
  }

  let server: Parameters<typeof shutdownInOrder>[0]["server"] = control;
  if (!config.controlOnly) {
    const app = createApp(storage, blobs, housekeeping, config, instanceId);
    await housekeeping.start();
    await housekeeping.runNow("webhook-schedule");
    const publicServer = serve(
      { fetch: app.fetch, port: config.port },
      (info) => {
        log("info", `Marfa server listening on port ${String(info.port)}`);
      },
    );
    publicServer.once("error", (error) => {
      log("error", "Public listener failed", {
        error: formatErrorSummary(error),
      });
      shutdown(1);
    });
    // Drain both listeners before storage is closed.
    server = {
      close(callback) {
        publicServer.close(() => control.close(callback));
      },
      closeIdleConnections() {
        if ("closeIdleConnections" in publicServer)
          publicServer.closeIdleConnections();
        control.closeIdleConnections();
      },
    };
  }

  let shuttingDown = false;
  const shutdown = (failureCode: 0 | 1 = 0): void => {
    // A second signal must not restart the sequence. The platform sends
    // SIGTERM and then, shortly after, SIGKILL; some supervisors send SIGTERM
    // twice. Re-entering would re-run every `stop()` and race two exits.
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownInOrder({
      bulkActionWorker,
      housekeeping,
      streams: { endAll: endOpenStreams },
      server,
      storage,
      // No-op when OTel is disabled. Accessed via an inline cast rather than
      // the ambient `declare global` so the per-entry .d.ts build stays typed.
      flushTelemetry: (
        globalThis as { __marfaOtelShutdown?: () => Promise<void> }
      ).__marfaOtelShutdown,
    }).then((exitCode) => {
      process.exit(failureCode || exitCode);
    });
  };

  process.on("SIGTERM", () => {
    shutdown();
  });
  process.on("SIGINT", () => {
    shutdown();
  });
}

main().catch((err: unknown) => {
  // A boot failure is the one log line an operator has to work from — the
  // process is gone a millisecond later and nothing else got written. Carry
  // the whole error, not just `.message`, which is empty for the shapes that
  // matter most here (an unreachable database surfaces as an AggregateError
  // whose detail lives in `errors`, a wrapped driver failure in `cause`).
  log("error", "Failed to start server", {
    error: formatErrorSummary(err),
    error_detail: serializeError(err),
  });
  // A database another build wrote is not a crash: starting again meets the
  // same file, so its own status lets what supervises the process stop
  // rather than start it in a loop.
  process.exit(
    err instanceof RefusedDatabaseError ? REFUSED_DATABASE_EXIT_CODE : 1,
  );
});
