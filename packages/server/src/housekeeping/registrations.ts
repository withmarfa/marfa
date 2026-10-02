import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";
import type { AppConfig } from "../config.js";
import { DEFAULT_INBOUND_LIMITS, defaultTessdataDir } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import type { Housekeeping } from "./scheduler.js";
import { log } from "../middleware/logger.js";
import {
  WebhookPoller,
  WEBHOOK_POLL_INTERVAL_MS,
} from "../webhooks/delivery.js";
import { createWebhookHttpClient } from "../webhooks/outbound-http.js";
import { HeartbeatPinger } from "../heartbeat.js";
import { VersionThinner } from "../storage/version-thinner.js";
import {
  RevokedGrantPurger,
  GrantInactivityRetirer,
  RevokedKeyReaper,
  TrashPurger,
  AuthSessionCleaner,
  RateLimitWindowCleaner,
  DcrClientCleaner,
  runSweepAtRetention,
} from "../storage/retention.js";
import { BlobReplicator } from "./blob-replicate.js";
import { BlobIntegrityChecker } from "./blob-integrity.js";
import { BlobOrphanReporter } from "./blob-orphans.js";
import type { RetentionOverride } from "../storage/retention.js";
import { TextEnrichmentSweeper } from "../enrichment/sweeper.js";
import { TesseractOcr } from "../enrichment/ocr.js";
import { BulkActionJobGcSweeper } from "../bulk-actions/index.js";

/**
 * Every housekeeping job the server runs on itself, registered from one
 * place so the set is a function of the configuration and can be asserted
 * as one. One its configuration switches off is not registered, so it is
 * not listed either; one whose retention `/config` can set while the
 * process runs is registered whatever the instance default, and sweeps
 * nothing until the retention is positive.
 */
export function registerHousekeepingJobs(
  housekeeping: Housekeeping,
  storage: Storage,
  blobs: BlobLayer,
  config: AppConfig,
): void {
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

  // Default 168h; override via MARFA_EVENT_LOG_RETENTION_HOURS or the instance config.
  const eventLogRetentionHours = config.eventLogRetentionHours ?? 168;
  housekeeping.register({
    name: "event-log-cleanup",
    intervalMs: config.eventLogCleanupIntervalMs ?? 3_600_000,
    firstRunDelayMs: 10_000,
    run: async () => {
      // Idempotency records ride this sweep rather than getting a sweeper
      // of their own, and the window is the same one deliberately: an
      // `Idempotency-Key` is answerable for as long as the events around it
      // are sure to stay replayable, so a client that can still catch up on
      // the stream can still ask what its write did. A second sweep would
      // be a second window to keep in step, and the effective retention is
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
      // Outbound delivery history rides this sweep: the webhook doors
      // promise it for exactly the audit window.
      let deliveries = 0;
      const deleted = await runSweepAtRetention({
        override: auditOverride,
        instanceDefault: config.auditRetentionDays,
        sweep: async (retention) => {
          deliveries +=
            await storage.outboundWebhookDeliveries.cleanup(retention);
          return storage.audit.cleanup(retention);
        },
      });
      if (deleted > 0 || deliveries > 0) {
        log(
          "info",
          `Purged ${String(deleted)} audit entries and ${String(deliveries)} outbound webhook deliveries (instance default: ${String(config.auditRetentionDays)} days; a /config override is honored)`,
        );
      }
      return { deleted, deliveries };
    },
  });

  // No first-run delay: on a fresh table a delivery left pending is picked
  // up at the first poll; on a restart, at the previous schedule.
  const webhookPoller = new WebhookPoller({
    storage,
    http: createWebhookHttpClient({
      allowPrivateAddresses: config.webhookAllowPrivateAddresses ?? false,
    }),
  });
  housekeeping.register({
    name: "webhook-poll",
    intervalMs: WEBHOOK_POLL_INTERVAL_MS,
    firstRunDelayMs: 0,
    run: () => webhookPoller.runOnce(),
  });

  // Opt-in liveness heartbeat: off unless the operator names a receiver.
  // No first-run delay, so a fresh instance is visible at its first poll;
  // a restarted one pings at its previous schedule.
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

  // Revoked application-grant rows, hourly. Unlike trash there is no
  // /config override for this window, because the reason for its length is
  // instance-wide: it tracks the audit retention so the revoked grant row and the
  // audit row that recorded the revocation cannot disagree about whether a
  // revocation is still visible. `0` disables.
  const revokedGrantRetentionDays = config.revokedGrantRetentionDays ?? 90;
  if (revokedGrantRetentionDays > 0) {
    const revokedGrantPurger = new RevokedGrantPurger(
      storage.items,
      revokedGrantRetentionDays,
    );
    housekeeping.register({
      name: "revoked-grant-purge",
      intervalMs: 3_600_000,
      firstRunDelayMs: 20_000,
      run: async () => ({ deleted: await revokedGrantPurger.runOnce() }),
    });
  }

  // A grant nobody has used for a year is retired through the same cascade
  // a Disconnect runs, with an audit row saying why. The revoked grant row it leaves
  // then falls to the revoked-grant purge above, and a client left with no
  // grant to the DCR reaper. `0` disables.
  // Daily, and deliberately not configurable: the window is measured in
  // days, so a finer cadence changes nothing but load, and the DCR reaper's
  // interval is that reaper's setting rather than this one's.
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

  const revokedKeyReaper = new RevokedKeyReaper(storage);
  housekeeping.register({
    name: "revoked-key-reap",
    intervalMs: 3_600_000,
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

  const inbound = config.inbound ?? DEFAULT_INBOUND_LIMITS;
  housekeeping.register({
    name: "inbound-delivery-cleanup",
    intervalMs: 3_600_000,
    firstRunDelayMs: 30_000,
    run: async () => ({
      deleted: await storage.inbound.cleanup({
        handledDays: inbound.handledRetentionDays,
        pendingDays: inbound.pendingRetentionDays,
      }),
    }),
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

  // The copy rules (`conformance/spec/stores.md`). Replication gives every
  // attached store the copies its policy wants; an upload wakes it, and a
  // run that made progress on a backlog it could not finish wakes it
  // again itself (one that copied nothing waits for its cadence, so a
  // store that refuses every put is asked once a minute rather than once
  // a second). The integrity check strikes a copy found missing or
  // altered and wakes replication to put it back. Neither has an off
  // switch: a store the configuration names is a store whose copies are
  // kept.
  const replicator = new BlobReplicator(storage, blobs, {
    maxBlobs: config.blobReplicateBatch ?? 100,
    maxBytes: config.blobReplicateBatchBytes ?? 1024 * 1024 * 1024,
  });
  housekeeping.register({
    name: "blob-replicate",
    intervalMs: config.blobReplicateIntervalMs ?? 60_000,
    firstRunDelayMs: 15_000,
    run: async () => {
      const result = await replicator.runOnce();
      if (result.copied > 0 && result.remaining > 0) {
        await housekeeping.wake("blob-replicate");
      }
      return result;
    },
  });
  const integrity = new BlobIntegrityChecker(storage, blobs, {
    maxRows: config.blobIntegrityBatch ?? 500,
    maxBytes: config.blobIntegrityBatchBytes ?? 1024 * 1024 * 1024,
  });
  housekeeping.register({
    name: "blob-integrity",
    intervalMs: config.blobIntegrityIntervalMs ?? 3_600_000,
    firstRunDelayMs: 60_000,
    run: async () => {
      const result = await integrity.runOnce();
      if (result.struck > 0) await housekeeping.wake("blob-replicate");
      return result;
    },
  });

  // Storing a blob and creating the item that references it are separate
  // calls, so an item write refused between them leaves bytes registered
  // and pointed at by nothing. The sweep reports such a blob on one run
  // and purges it on a later one, once the grace has passed since the
  // report, so the gap between a legitimate upload and its item write is
  // never mistaken for the leak. Interval `0` switches the sweep off.
  const blobCleanupIntervalMs = config.blobCleanupIntervalMs ?? 86_400_000;
  if (blobCleanupIntervalMs > 0) {
    const orphans = new BlobOrphanReporter(
      storage,
      blobs,
      config.blobCleanupGraceMs ?? 86_400_000,
    );
    housekeeping.register({
      name: "blob-orphans",
      intervalMs: blobCleanupIntervalMs,
      firstRunDelayMs: 30_000,
      run: () => orphans.runOnce(),
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
              cachePath:
                config.enrichmentTessdataDir ??
                defaultTessdataDir(config.sqlitePath),
            })
          : null,
      batchSize: config.enrichmentBatchSize ?? 8,
      itemTimeoutMs: config.enrichmentItemTimeoutMs ?? 60_000,
      maxBlobBytes: config.enrichmentMaxBlobBytes ?? 20 * 1024 * 1024,
      maxTextChars: config.enrichmentMaxTextChars ?? DEFAULT_MAX_STRING_LENGTH,
      maxAttempts: config.enrichmentMaxAttempts ?? 3,
    });
    housekeeping.register({
      name: "enrichment-sweep",
      intervalMs: config.enrichmentIntervalMs ?? 30_000,
      firstRunDelayMs: 20_000,
      run: () => enrichmentSweeper.runOnce(),
    });
  }

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
}
