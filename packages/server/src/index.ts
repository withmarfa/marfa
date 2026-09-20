import { serve } from "@hono/node-server";
import {
  ensureBootstrapSecret,
  isBootstrapped,
} from "./auth/bootstrap-secret.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadConfig,
  setActivePermissionBundles,
  hasUsablePermissionBundleOverride,
} from "./config.js";
import {
  buildDefaultPermissionBundles,
  resolveAllRegisteredNamespaceRoots,
  resolveRegisteredNamespaceRoots,
} from "./auth/default-bundles.js";
import { setRuntimeNamespaceRoots } from "./auth/oauth-provider.js";
import { createApp } from "./app.js";
import { ensureInstanceId } from "./storage/instance-id.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import type { Storage } from "./storage/interface.js";
import {
  WebhookConsumer,
  WebhookPoller,
  WEBHOOK_POLL_INTERVAL_MS,
} from "./webhooks/delivery.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { HeartbeatPinger } from "./heartbeat.js";
import { VersionThinner } from "./storage/version-thinner.js";
import {
  ActivityPurger,
  RevokedGrantPurger,
  GrantInactivityRetirer,
  RevokedKeyReaper,
  TrashPurger,
  AuthSessionCleaner,
  RateLimitWindowCleaner,
  DcrClientCleaner,
  BlobOrphanCleaner,
  runSweepAtRetention,
} from "./storage/retention.js";
import type { RetentionOverride } from "./storage/retention.js";
import { initEventLog } from "./pubsub.js";
import { TextEnrichmentSweeper } from "./enrichment/sweeper.js";
import { TesseractOcr } from "./enrichment/ocr.js";
import {
  log,
  formatErrorSummary,
  serializeError,
} from "./middleware/logger.js";
import { OidcSigner } from "./auth/oidc-signing.js";
import {
  BulkActionWorker,
  setBulkJobEnqueueListener,
  BulkActionJobGcSweeper,
} from "./bulk-actions/index.js";

async function main() {
  const config = loadConfig();

  // version.json is written at deploy time; absent in dev (falls back to "dev").
  try {
    const versionPath = resolve(process.cwd(), "version.json");
    const raw = await readFile(versionPath, "utf-8");
    const version = JSON.parse(raw) as Record<string, unknown>;
    if (typeof version.sha === "string" && version.sha) {
      config.versionSha = version.sha;
    }
    log("info", "Server version", {
      sha: version.sha,
      deployed_at: version.deployed_at,
    });
  } catch {
    log("info", "Server version", { sha: "dev" });
  }

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

  // Every periodic job the server runs on itself registers here and runs
  // from the housekeeping table. A job disabled by configuration is not
  // registered, so it is not listed either.
  const housekeeping = new Housekeeping(storage.housekeeping, {
    pollIntervalMs: config.housekeepingPollIntervalMs ?? 1_000,
  });

  const auditOverride: RetentionOverride = {
    settings: storage.settings,
    configField: "audit_retention_days",
  };
  const eventLogOverride: RetentionOverride = {
    settings: storage.settings,
    configField: "event_log_retention_hours",
  };
  const trashOverride: RetentionOverride = {
    settings: storage.settings,
    configField: "trash_retention_days",
  };
  const activityOverride: RetentionOverride = {
    settings: storage.settings,
    configField: "activity_retention_days",
  };

  // Default 168h; override via MARFA_EVENT_LOG_RETENTION_HOURS or the instance config.
  const eventLogRetentionHours = config.eventLogRetentionHours ?? 168;
  housekeeping.register({
    name: "event-log-cleanup",
    intervalMs: config.eventLogCleanupIntervalMs ?? 3_600_000,
    firstRunDelayMs: 10_000,
    run: async () => {
      // Idempotency records ride this sweep rather than getting a sweeper
      // of their own, and the window is the same one deliberately: an
      // `Idempotency-Key` is answerable for exactly as long as the events
      // around it stay replayable, so a client that can still catch up on
      // the stream can still ask what its write did. A second job would be
      // a second window to keep in step, and the effective retention is
      // already resolved here.
      let purgedRecords = 0;
      const deleted = await runSweepAtRetention({
        override: eventLogOverride,
        instanceDefault: eventLogRetentionHours,
        sweep: async (retention) => {
          purgedRecords += await storage.idempotency.cleanup(retention);
          return storage.eventLog.cleanup(retention);
        },
      });
      if (deleted > 0 || purgedRecords > 0) {
        log(
          "info",
          `Purged ${String(deleted)} event_log entries and ${String(purgedRecords)} idempotency records (instance default: ${String(eventLogRetentionHours)} hours; a /config override is honored)`,
        );
      }
      return { deleted, purged_records: purgedRecords };
    },
  });

  housekeeping.register({
    name: "audit-cleanup",
    intervalMs: config.auditCleanupIntervalMs,
    firstRunDelayMs: 5_000,
    run: async () => {
      const deleted = await runSweepAtRetention({
        override: auditOverride,
        instanceDefault: config.auditRetentionDays,
        sweep: (retention) => storage.audit.cleanup(retention),
      });
      if (deleted > 0) {
        log(
          "info",
          `Purged ${String(deleted)} audit entries (instance default: ${String(config.auditRetentionDays)} days; a /config override is honored)`,
        );
      }
      return { deleted };
    },
  });

  const webhookConsumer = new WebhookConsumer(
    storage.outboundWebhooks,
    storage.outboundWebhookDeliveries,
  );
  webhookConsumer.start();

  // No delay: a delivery left pending by the last process is picked up as
  // soon as this one is listening.
  const webhookPoller = new WebhookPoller(storage.outboundWebhookDeliveries);
  housekeeping.register({
    name: "webhook-poll",
    intervalMs: WEBHOOK_POLL_INTERVAL_MS,
    firstRunDelayMs: 0,
    run: () => webhookPoller.runOnce(),
  });

  // Opt-in liveness heartbeat: off unless the operator names a receiver.
  // Pinged at once, so a freshly booted instance is visible before the
  // first interval elapses.
  if (config.heartbeatUrl) {
    const heartbeat = new HeartbeatPinger(config.heartbeatUrl);
    housekeeping.register({
      name: "heartbeat",
      intervalMs: config.heartbeatIntervalMs ?? 60_000,
      firstRunDelayMs: 0,
      run: () => heartbeat.runOnce(),
    });
  }

  const versionThinner = new VersionThinner(storage.versions, {
    recentDays: config.versionRecentDays,
    dailySnapshotDays: config.versionDailySnapshotDays,
    weeklySnapshotDays: config.versionWeeklySnapshotDays,
    maxVersions: config.versionMaxVersions,
  });
  housekeeping.register({
    name: "version-thinning",
    intervalMs: config.versionThinningIntervalMs,
    firstRunDelayMs: 5_000,
    run: () => versionThinner.runOnce(),
  });

  // Registered whatever the instance default, because the retention can
  // be turned on through `/config` while the process runs.
  const trashPurger = new TrashPurger(
    storage.items,
    config.trashRetentionDays,
    undefined,
    trashOverride,
  );
  housekeeping.register({
    name: "trash-purge",
    intervalMs: config.trashPurgeIntervalMs,
    firstRunDelayMs: 5_000,
    run: async () => ({ deleted: await trashPurger.runOnce() }),
  });

  // Activity rows are ordinary items, one per connector run, so they are
  // the fastest-growing type on an instance with connections and the one
  // that needs a bound of its own. Same fan-out shape as trash; `0` on the
  // interval disables.
  const activityPurgeIntervalMs = config.activityPurgeIntervalMs ?? 3_600_000;
  if (activityPurgeIntervalMs > 0) {
    const activityPurger = new ActivityPurger(
      storage.items,
      config.activityRetentionDays ?? 14,
      undefined,
      activityOverride,
    );
    housekeeping.register({
      name: "activity-purge",
      intervalMs: activityPurgeIntervalMs,
      firstRunDelayMs: 15_000,
      run: async () => ({ deleted: await activityPurger.runOnce() }),
    });
    // Revoked application-grant tombstones. Unlike trash and activity there
    // is no /config override for this window, because the reason for its
    // length is instance-wide — it tracks the audit retention so the
    // tombstone and the audit row that recorded the revocation cannot
    // disagree about whether a revocation is still visible.
    const revokedGrantPurger = new RevokedGrantPurger(
      storage.items,
      config.revokedGrantRetentionDays ?? 90,
    );
    housekeeping.register({
      name: "revoked-grant-purge",
      intervalMs: activityPurgeIntervalMs,
      firstRunDelayMs: 20_000,
      run: async () => ({ deleted: await revokedGrantPurger.runOnce() }),
    });
  }

  // A grant nobody has used for a year is retired through the same cascade
  // a Disconnect runs, with an audit row saying why. The tombstone it leaves
  // then falls to the revoked-grant purge above, and a client left with no
  // grant to the DCR reaper. `0` disables.
  // Daily, and deliberately not configurable: the window is measured in
  // days, so a finer cadence changes nothing but load, and the DCR reaper's
  // interval is that job's setting rather than this one's.
  const grantInactivityDays = config.grantInactivityDays ?? 365;
  if (grantInactivityDays > 0) {
    const grantInactivityRetirer = new GrantInactivityRetirer(
      storage,
      grantInactivityDays,
    );
    housekeeping.register({
      name: "grant-inactivity-retirement",
      intervalMs: 86_400_000,
      firstRunDelayMs: 40_000,
      run: async () => ({ retired: await grantInactivityRetirer.runOnce() }),
    });
  }

  // On the activity purge's cadence, which is the hourly one; hourly when
  // that purge is off, because its interval is then no cadence at all.
  const revokedKeyReaper = new RevokedKeyReaper(storage);
  housekeeping.register({
    name: "revoked-key-reap",
    intervalMs:
      activityPurgeIntervalMs > 0 ? activityPurgeIntervalMs : 3_600_000,
    firstRunDelayMs: 45_000,
    run: async () => ({ deleted: await revokedKeyReaper.runOnce() }),
  });

  // Gated on authSessions being wired; test contexts that skip better-auth omit it.
  if (storage.authSessions) {
    const authSessionCleaner = new AuthSessionCleaner(storage.authSessions);
    housekeeping.register({
      name: "auth-session-cleanup",
      intervalMs: config.authSessionCleanupIntervalMs ?? 3_600_000,
      firstRunDelayMs: 10_000,
      run: async () => ({ deleted: await authSessionCleaner.runOnce() }),
    });
  }

  // GC keeps the table bounded; expired rows are correctness-safe (upsert path
  // overwrites them transparently).
  const rateLimitCleaner = new RateLimitWindowCleaner(storage);
  housekeeping.register({
    name: "rate-limit-cleanup",
    intervalMs: config.rateLimitCleanupIntervalMs ?? 3_600_000,
    firstRunDelayMs: 20_000,
    run: async () => ({ deleted: await rateLimitCleaner.runOnce() }),
  });

  // Reap grantless DCR clients so unauthenticated registration doesn't grow
  // `auth_oauth_client` unbounded. Gated on a positive retention window
  // (`0` disables) and on the oauth-provider store being wired (test
  // contexts that skip better-auth omit it).
  const dcrRetentionDays = config.dcrClientRetentionDays ?? 30;
  if (dcrRetentionDays > 0 && storage.oauthProvider) {
    const dcrClientCleaner = new DcrClientCleaner(storage, dcrRetentionDays);
    housekeeping.register({
      name: "dcr-client-cleanup",
      intervalMs: config.dcrClientCleanupIntervalMs ?? 86_400_000,
      firstRunDelayMs: 25_000,
      run: async () => ({ deleted: await dcrClientCleaner.runOnce() }),
    });
  }

  // Storing a blob and creating the item that references it are separate
  // calls, so an item write refused between them leaves bytes registered
  // and pointed at by nothing. The sweep runs behind a grace window so the
  // gap between a legitimate upload and its item write is not mistaken for
  // the leak. Grace `0` disables the job.
  const blobCleanupGraceMs = config.blobCleanupGraceMs ?? 86_400_000;
  if (blobCleanupGraceMs > 0) {
    const blobOrphanCleaner = new BlobOrphanCleaner(
      storage,
      blobs,
      blobCleanupGraceMs,
    );
    housekeeping.register({
      name: "blob-orphans",
      intervalMs: config.blobCleanupIntervalMs ?? 86_400_000,
      firstRunDelayMs: 30_000,
      run: async () => ({ removed: await blobOrphanCleaner.runOnce() }),
    });
  }

  // Text extraction from uploaded files, on by default: a document nobody
  // can find is barely stored. The OCR engine is constructed eagerly but
  // loads nothing until an image actually reaches it. The first sweep
  // waits, because boot is the busiest the process ever is and nothing
  // here is urgent.
  if (config.enrichmentEnabled !== false) {
    const enrichmentSweeper = new TextEnrichmentSweeper({
      storage,
      blobs,
      ocr:
        config.enrichmentOcrEnabled !== false
          ? new TesseractOcr({
              cachePath: config.enrichmentTessdataDir ?? "./data/tessdata",
            })
          : null,
      batchSize: config.enrichmentBatchSize ?? 8,
      itemTimeoutMs: config.enrichmentItemTimeoutMs ?? 60_000,
      maxBlobBytes: config.enrichmentMaxBlobBytes ?? 20 * 1024 * 1024,
      maxTextChars: config.enrichmentMaxTextChars ?? 200_000,
      maxAttempts: config.enrichmentMaxAttempts ?? 3,
    });
    housekeeping.register({
      name: "enrichment-sweep",
      intervalMs: config.enrichmentIntervalMs ?? 30_000,
      firstRunDelayMs: 20_000,
      run: () => enrichmentSweeper.runOnce(),
    });
  }

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
  await bulkActionWorker.start();
  // A zero or negative retention disables the sweep, and the table grows
  // unbounded.
  const bulkActionJobRetentionMs =
    config.bulkActionJobRetentionMs ?? 7 * 24 * 3_600_000;
  if (bulkActionJobRetentionMs > 0) {
    const bulkActionGc = new BulkActionJobGcSweeper(
      storage,
      bulkActionJobRetentionMs,
    );
    housekeeping.register({
      name: "bulk-action-gc",
      intervalMs: config.bulkActionJobGcIntervalMs ?? 3_600_000,
      firstRunDelayMs: 60_000,
      run: async () => ({ deleted: await bulkActionGc.runOnce() }),
    });
  }

  const oidcSigner = await OidcSigner.init(storage);

  // Admit the runtime custom-namespace roots into the OAuth scope
  // allowlist, before the auth instance is built. Admission only — nothing
  // user-visible: the consent screen derives its roots at render time, and
  // the discovery advertisement is pinned to the baseline. Installed
  // regardless of the bundle override below, because whether a registered
  // namespace is grantable is not the operator's consent-curation lever.
  setRuntimeNamespaceRoots(await resolveAllRegisteredNamespaceRoots(storage));

  // Fold the runtime custom-type namespaces into the active permission
  // bundles, so a custom type under a claimed publisher handle is offerable
  // through the default consent set rather than only `user.*`.
  // A *usable* override outranks the derivation and skips it entirely. An
  // override that failed validation does not: it has already fallen back to
  // the shipped bundles, and skipping here as well would drop the handle
  // namespaces too, so one bad environment variable would cost two things
  // rather than one.
  if (!hasUsablePermissionBundleOverride()) {
    const bundles = buildDefaultPermissionBundles(
      await resolveRegisteredNamespaceRoots(storage),
    );
    setActivePermissionBundles(bundles);
    config.permissionBundles = bundles;
  }

  // **The bootstrap window, announced.** An instance that has never minted a
  // credential accepts one unauthenticated `POST /keys`, and the secret below
  // is what binds that call to whoever is running the instance rather than to
  // whoever reaches the port first. Printed at every boot until it is used, so
  // a restart does not strand an operator who has already copied it.
  //
  // Nothing is printed on an instance that already holds a credential, which
  // is every deployment past its first minute.
  if (!(await isBootstrapped(storage))) {
    const secret = await ensureBootstrapSecret(storage);
    // **Kept out of the telemetry mirror.** The redactor rewrites attributes
    // and leaves the message body alone, on the reasoning that a body is
    // Marfa-controlled and therefore safe. This body is a credential, so
    // exporting it would put the key to the instance in whatever backend
    // receives logs — turning "can read the boot log" into "can read the
    // observability stack", which is not the claim this secret is meant to
    // stand for.
    log(
      "warn",
      `This instance holds no credential yet. Mint the first one with: ` +
        `curl -X POST <url>/keys -H "Authorization: Bearer ${secret}" ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"label":"operator","source":"operator"}'. ` +
        `This secret works once and is not shown again after that mint.`,
      undefined,
      { localOnly: true },
    );
  }

  // **Minted at first boot**, so an instance holds its name before it has
  // answered anything and before the socket is listening. The root route is
  // handed the value rather than reading it, which is what keeps that one
  // door answerable on an instance whose database has since gone.
  const instanceId = await ensureInstanceId(storage.settings);

  const app = createApp(
    storage,
    blobs,
    housekeeping,
    config,
    instanceId,
    oidcSigner,
  );
  await housekeeping.start();
  log("info", "Housekeeping started", { jobs: housekeeping.names() });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("info", `Marfa server listening on port ${String(info.port)}`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    // A second signal must not restart the sequence. The platform sends
    // SIGTERM and then, shortly after, SIGKILL; some supervisors send SIGTERM
    // twice. Re-entering would re-run every `stop()` and race two exits.
    if (shuttingDown) return;
    shuttingDown = true;
    void runShutdown();
  };

  async function runShutdown(): Promise<void> {
    // Emitted before anything is torn down, so the record is in the telemetry
    // pipeline as early as possible — everything below only shortens the time
    // it has to get out.
    log("info", "Shutting down...");
    webhookConsumer.stop();
    bulkActionWorker.stop();
    // Each step bounded and reported separately: a shared catch produced a
    // warning that could not say which step overran, and it fired on every
    // production shutdown for a week before anything made it loud.
    let exitCode = 0;
    try {
      await withTimeout(closeServer(server), SHUTDOWN_STEP_TIMEOUT_MS);
    } catch (error) {
      log("warn", "Graceful shutdown: HTTP server close did not complete", {
        error: serializeError(error),
      });
      exitCode = 1;
    }
    // Before the storage closes, so a run in flight can write its record;
    // one that outlives the bound meets the closed client and stands down.
    try {
      await withTimeout(housekeeping.stop(), SHUTDOWN_STEP_TIMEOUT_MS);
    } catch (error) {
      log("warn", "Graceful shutdown: housekeeping did not stop in time", {
        error: serializeError(error),
      });
    }
    try {
      await withTimeout(storage.close(), SHUTDOWN_STEP_TIMEOUT_MS);
    } catch (error) {
      log("warn", "Graceful shutdown: storage close did not complete", {
        error: serializeError(error),
      });
      exitCode = 1;
    }

    // Flush and shut down OpenTelemetry before exit, unconditionally and
    // whatever happened above. This is the step that decides whether the
    // shutdown record exists at all: log records leave through a batching
    // processor, so a process that exits without flushing takes its final
    // batch with it. That loss is not cosmetic — a missing shutdown line is
    // read downstream as a process that died rather than stopped, so an
    // orderly scale-to-zero becomes indistinguishable from a crash.
    //
    // It runs outside the try above precisely because the failure path needs
    // it most: a shutdown that timed out is a shutdown worth having a record
    // of. No-op when OTel is disabled. Accessed via an inline cast rather than
    // the ambient `declare global` so the per-entry .d.ts build stays typed.
    const flushTelemetry = (
      globalThis as { __marfaOtelShutdown?: () => Promise<void> }
    ).__marfaOtelShutdown;
    if (flushTelemetry) {
      await withTimeout(flushTelemetry(), TELEMETRY_FLUSH_TIMEOUT_MS).catch(
        () => undefined,
      );
    }

    process.exit(exitCode);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Every wait during shutdown is bounded, because the process is racing a
 * SIGKILL it cannot see coming. An unbounded wait does not buy a cleaner
 * stop — it spends the whole grace period on one step and then loses the
 * telemetry flush to the kill, which is how a clean shutdown ends up looking
 * like a crash.
 *
 * `server.close()` is the specific hazard. It resolves only once every
 * connection has ended, and a keep-alive connection has not ended just
 * because no request is in flight, so a single idle client can hold it open
 * indefinitely. `closeIdleConnections()` below removes the common case; the
 * timeout covers the rest.
 */
const SHUTDOWN_STEP_TIMEOUT_MS = 3_000;
const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeServer(server: {
  close: (cb?: (err?: Error) => void) => void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolvePromise();
    });
    // Stop waiting on sockets that are merely parked. In-flight requests still
    // get to finish; idle keep-alive sockets are what would otherwise hold the
    // close open for the whole grace period.
    server.closeIdleConnections?.();
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
  process.exit(1);
});
