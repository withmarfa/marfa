import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { Storage } from "./storage/interface.js";
import { WebhookConsumer, WebhookPoller } from "./webhooks/delivery.js";
import { VersionThinner } from "./storage/version-thinner.js";
import {
  TrashPurger,
  AuthSessionCleaner,
  PendingDeletePurger,
  RateLimitWindowCleaner,
  runTenantCleanup,
} from "./storage/retention.js";
import type { TenantFanout } from "./storage/retention.js";
import { initEventLog, defaultCycleDetectionWiring } from "./pubsub.js";
import { tryStartReactiveRunBridge } from "./connections/reactive-run-bridge.js";
import {
  tryStartLocalIntegrationRuntime,
  loadInTreeRegistrations,
  type LocalRuntimeBundle,
} from "./integrations/local-runtime/index.js";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./middleware/logger.js";
import { createEmailTransport } from "./email/index.js";
import { OidcSigner } from "./auth/oidc-signing.js";
import {
  BulkActionWorker,
  BulkActionJobGcSweeper,
} from "./bulk-actions/index.js";

async function main() {
  const config = loadConfig();

  // Log version info at startup and surface the same sha on `GET /` (§3.15).
  // version.json is written at deploy time; in dev it's absent and we
  // fall back to "dev". Empty / non-string sha values fall back too.
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

  let storage: Storage;
  if (config.storageDialect === "pg") {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when DB_DIALECT=pg");
    }
    storage = await createPgStorage(config.databaseUrl, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
      authMode: config.authMode,
    });
  } else {
    storage = await createSqliteStorage(config.sqlitePath, {
      versionSnapshotIntervalMs: config.versionSnapshotIntervalMs,
      authMode: config.authMode,
    });
  }

  let blobBackend: BlobBackend;
  if (config.blobBackend === "s3") {
    const { S3BlobBackend } = await import("./storage/blob-s3.js");
    blobBackend = new S3BlobBackend({
      bucket: config.s3Bucket,
      region: config.s3Region,
      endpoint: config.s3Endpoint || undefined,
      accessKeyId: config.s3AccessKeyId || undefined,
      secretAccessKey: config.s3SecretAccessKey || undefined,
    });
  } else {
    blobBackend = new FilesystemBlobBackend(config.blobPath);
  }
  // Enable SSE event persistence
  initEventLog(storage.eventLog, defaultCycleDetectionWiring(storage));

  // Reactive-run bridge — opt-in via CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS
  // + CLOUDFLARE_QUEUES_API_TOKEN. When unset, returns null and the
  // server boots without the Cloudflare Queues hop (self-hoster path).
  // When set, the bridge subscribes to pubsub and forwards `item-event`s
  // to the per-integration queue producer for fanout to the owning
  // per-Integration Worker.
  const reactiveRunBridge = tryStartReactiveRunBridge(storage, {
    sendTimeoutMs: config.reactiveRunSendTimeoutMs,
  });
  if (reactiveRunBridge) {
    void reactiveRunBridge
      .start()
      .then(() => {
        log("info", "Reactive-run bridge started");
      })
      .catch((err: unknown) => {
        log("error", "Reactive-run bridge start failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } else {
    log(
      "info",
      "Reactive-run bridge disabled (CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS / CLOUDFLARE_QUEUES_API_TOKEN unset or malformed)",
    );
  }

  // Per-tenant retention fan-out is wired when the storage backend
  // exposes a `tenants` store (always in production). The fan-out lists
  // every tenant once per tick and runs each cleanup honouring the
  // per-tenant override; a NULL-tenant sweep at the instance default
  // catches single-tenant self-host items. Coordination locks are keyed
  // per-tenant so multi-instance deployments don't double-process.
  const auditFanout: TenantFanout | undefined = storage.tenants
    ? { tenants: storage.tenants, configField: "audit_retention_days" }
    : undefined;
  const eventLogFanout: TenantFanout | undefined = storage.tenants
    ? { tenants: storage.tenants, configField: "event_log_retention_hours" }
    : undefined;
  const trashFanout: TenantFanout | undefined = storage.tenants
    ? { tenants: storage.tenants, configField: "trash_retention_days" }
    : undefined;

  // Event log retention — clean up events older than the configured
  // window (default 168h / 7d; override via MARFA_EVENT_LOG_RETENTION_HOURS,
  // or per-tenant via TenantConfig.event_log_retention_hours).
  // Advisory-locked per-tenant so multi-instance deployments run each
  // sweep once per tick cluster-wide.
  const eventLogRetentionHours = config.eventLogRetentionHours ?? 168;
  const runEventLogCleanup = () => {
    void runTenantCleanup({
      jobName: "event-log-cleanup",
      coordination: storage.coordination,
      fanout: eventLogFanout,
      instanceDefault: eventLogRetentionHours,
      unitMs: 3_600_000,
      sweep: (retention, tenantId) =>
        storage.eventLog.cleanup(retention, tenantId),
    }).then((deleted) => {
      if (deleted > 0)
        log(
          "info",
          `Purged ${String(deleted)} event_log entries (instance default: ${String(eventLogRetentionHours)} hours; per-tenant overrides honoured)`,
        );
    });
  };
  const eventLogCleanupDelay = setTimeout(runEventLogCleanup, 10_000);
  const eventLogCleanupInterval = setInterval(runEventLogCleanup, 3_600_000);

  // Audit retention — run once after startup, then on a daily schedule.
  // Per-tenant overrides via TenantConfig.audit_retention_days.
  const runAuditCleanup = () => {
    void runTenantCleanup({
      jobName: "audit-cleanup",
      coordination: storage.coordination,
      fanout: auditFanout,
      instanceDefault: config.auditRetentionDays,
      unitMs: 86_400_000,
      sweep: (retention, tenantId) =>
        storage.audit.cleanup(retention, tenantId),
    }).then((deleted) => {
      if (deleted > 0)
        log(
          "info",
          `Purged ${String(deleted)} audit entries (instance default: ${String(config.auditRetentionDays)} days; per-tenant overrides honoured)`,
        );
    });
  };
  const auditCleanupDelay = setTimeout(runAuditCleanup, 5_000);
  const auditCleanupInterval = setInterval(
    runAuditCleanup,
    config.auditCleanupIntervalMs,
  );

  const webhookConsumer = new WebhookConsumer(
    storage.outboundWebhooks,
    storage.outboundWebhookDeliveries,
  );
  webhookConsumer.start();

  const webhookPoller = new WebhookPoller(storage.outboundWebhookDeliveries);
  webhookPoller.start();

  const versionThinner = new VersionThinner(
    storage.versions,
    {
      recentDays: config.versionRecentDays,
      dailySnapshotDays: config.versionDailySnapshotDays,
      weeklySnapshotDays: config.versionWeeklySnapshotDays,
      maxVersions: config.versionMaxVersions,
    },
    config.versionThinningIntervalMs,
    storage.coordination,
  );
  versionThinner.start();

  const trashPurger = new TrashPurger(
    storage.items,
    config.trashRetentionDays,
    config.trashPurgeIntervalMs,
    undefined,
    storage.coordination,
    trashFanout,
  );
  trashPurger.start();

  // Drop expired better-auth `auth_session` rows on a periodic tick.
  // Gated on the storage adapter exposing `authSessions` — test
  // contexts that don't wire better-auth skip the job entirely.
  const authSessionCleaner = storage.authSessions
    ? new AuthSessionCleaner(
        storage.authSessions,
        config.authSessionCleanupIntervalMs ?? 3_600_000,
        undefined,
        storage.coordination,
      )
    : undefined;
  authSessionCleaner?.start();

  // Pending-delete purger. Gated on `accountLifecycle` being wired —
  // production storage always wires it; bare test stubs that omit it
  // skip the job.
  const pendingDeletePurger = storage.accountLifecycle
    ? new PendingDeletePurger(
        storage,
        config.accountDeletionGraceDays ?? 30,
        config.accountDeletionPurgeIntervalMs ?? 3_600_000,
        undefined,
        storage.coordination,
      )
    : undefined;
  pendingDeletePurger?.start();

  // Drop expired `rate_limit_windows` rows on a periodic tick. Expired
  // rows aren't a correctness risk (the upsert path overwrites them
  // transparently); the GC just keeps the table bounded. Cluster-
  // coordinated via the named lock so multi-instance deployments don't
  // double-process.
  const rateLimitCleaner = new RateLimitWindowCleaner(
    storage,
    config.rateLimitCleanupIntervalMs ?? 3_600_000,
    undefined,
    storage.coordination,
  );
  rateLimitCleaner.start();

  // In-process worker for async bulk_action jobs + periodic GC sweep
  // over terminal rows. On PG the worker's `claimNext` uses
  // `SELECT … FOR UPDATE SKIP LOCKED` so multi-instance deployments
  // coordinate naturally; SQLite is single-process by design. The GC
  // sweep is cluster-coordinated via `withJobLock`.
  const bulkActionWorker = new BulkActionWorker({ storage });
  await bulkActionWorker.start();
  const bulkActionGc = new BulkActionJobGcSweeper(
    storage,
    config.bulkActionJobRetentionMs ?? 7 * 24 * 3_600_000,
    config.bulkActionJobGcIntervalMs ?? 3_600_000,
    undefined,
    storage.coordination,
  );
  bulkActionGc.start();

  // Construct the email transport once at boot and thread it into
  // createApp. The factory's sender-domain check fails loud here if
  // MARFA_EMAIL_FROM doesn't end @mail.marfa.so on the Cloudflare
  // backend, preventing bad config reaching the request loop. The
  // `none` default returns the explicit-failure transport so
  // email-dependent flows surface a clean
  // `email_transport_not_configured` error instead of silently
  // dead-lettering.
  // Treat empty strings from `config` as "unset" — env vars come back
  // as "" rather than undefined, but the transport expects undefined
  // for optional fields. `emptyToUndef` is the trivial nullable cast.
  const emptyToUndef = (v: string | undefined): string | undefined =>
    v && v.length > 0 ? v : undefined;
  const emailTransport = await createEmailTransport({
    backend: config.emailBackend ?? "none",
    from: emptyToUndef(config.emailFrom) ?? "Marfa <hello@mail.marfa.so>",
    replyTo: emptyToUndef(config.emailReplyTo),
    cloudflare:
      emptyToUndef(config.cloudflareAccountId) &&
      emptyToUndef(config.cloudflareEmailApiToken)
        ? {
            accountId: config.cloudflareAccountId ?? "",
            apiToken: config.cloudflareEmailApiToken ?? "",
          }
        : undefined,
    smtp: emptyToUndef(config.smtpHost)
      ? {
          host: config.smtpHost ?? "",
          port: config.smtpPort ?? 587,
          user: emptyToUndef(config.smtpUser),
          pass: emptyToUndef(config.smtpPass),
          secure: config.smtpSecure ?? false,
        }
      : undefined,
  });

  // OIDC signer (RSA keypair persisted in `settings`). Init at boot so
  // the JWKS endpoint and id_token issuance can use it synchronously
  // inside request handlers.
  const oidcSigner = await OidcSigner.init(storage);

  // Boot the local integrations runtime when
  // MARFA_INTEGRATION_RUNTIME=local (the default). Set the env var to
  // "hosted" explicitly to delegate to the Cloudflare bridge instead.
  let localRuntime: LocalRuntimeBundle | null = null;
  if ((config.integrationRuntime ?? "local") === "local") {
    try {
      const integrationsRoot = resolveIntegrationsRoot();
      const registrations = integrationsRoot
        ? await loadInTreeRegistrations({ integrationsRoot })
        : [];
      if (registrations.length === 0) {
        log(
          "warn",
          "Local integration runtime enabled but no integrations declare `runtime_compatibility: ['local']` and ship dist/local.js. " +
            "Set MARFA_INTEGRATION_RUNTIME=hosted to use the Cloudflare substrate instead.",
        );
      }
      const PgBossModule = (await import("pg-boss")) as unknown as {
        default: new (cs: string) => unknown;
      };
      const PgBoss = PgBossModule.default;
      const boss = new PgBoss(config.databaseUrl);

      await (boss as { start: () => Promise<unknown> }).start();
      localRuntime = await tryStartLocalIntegrationRuntime({
        storage,
        config,
        registrations,
        boss: boss as Parameters<
          typeof tryStartLocalIntegrationRuntime
        >[0]["boss"],
        apiUrl: `http://localhost:${String(config.port)}`,
      });
      log("info", "Local integration runtime started", {
        registrations: registrations.length,
      });
    } catch (err) {
      log("error", "Local integration runtime failed to start", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  const app = createApp(
    storage,
    blobBackend,
    config,
    emailTransport,
    oidcSigner,
    localRuntime?.app,
  );

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("info", `Marfa server listening on port ${String(info.port)}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    log("info", "Shutting down...");
    webhookConsumer.stop();
    webhookPoller.stop();
    clearTimeout(eventLogCleanupDelay);
    clearInterval(eventLogCleanupInterval);
    clearTimeout(auditCleanupDelay);
    clearInterval(auditCleanupInterval);
    versionThinner.stop();
    trashPurger.stop();
    authSessionCleaner?.stop();
    pendingDeletePurger?.stop();
    rateLimitCleaner.stop();
    bulkActionWorker.stop();
    bulkActionGc.stop();
    if (reactiveRunBridge) {
      void reactiveRunBridge.stop().catch(() => {
        // Bridge cleanup errors during shutdown are swallowed; the
        // process is exiting anyway and the underlying coordination
        // lock will release with the connection.
      });
    }
    if (localRuntime) {
      void localRuntime.bridge.stop().catch(() => undefined);
      void localRuntime.runtime.stop().catch(() => undefined);
    }
    server.close(() => {
      storage
        .close()
        // Flush + shut down OpenTelemetry before exit so the final batch
        // of logs/traces isn't lost on the ephemeral hosted container
        // (scale-to-zero SIGTERM). No-op when OTel is disabled. Accessed
        // via an inline cast rather than the ambient `declare global` so
        // the per-entry .d.ts build stays typed.
        .then(() =>
          (
            globalThis as {
              __marfaOtelShutdown?: () => Promise<void>;
            }
          ).__marfaOtelShutdown?.(),
        )
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Resolve the in-tree `integrations/` directory from the running
 * server bundle. The server compiles to `packages/server/dist/index.js`
 * inside the repo; from there `../../integrations` is the monorepo's
 * integration source tree. When the server runs outside the monorepo
 * (e.g. a packaged Docker image carrying only `dist`), the operator
 * sets `MARFA_INTEGRATIONS_ROOT` explicitly.
 */
function resolveIntegrationsRoot(): string | null {
  const explicit = process.env.MARFA_INTEGRATIONS_ROOT;
  if (explicit) return explicit;
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    return resolvePath(here, "..", "..", "..", "integrations");
  } catch {
    return null;
  }
}

main().catch((err: unknown) => {
  log("error", "Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
