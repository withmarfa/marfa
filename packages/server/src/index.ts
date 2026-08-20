import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { pgEndpointHost } from "./storage/pg/endpoint.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { Storage } from "./storage/interface.js";
import {
  WebhookConsumer,
  WebhookPoller,
  WEBHOOK_POLL_INTERVAL_MS,
} from "./webhooks/delivery.js";
import { withStartupWait } from "./storage/startup-wait.js";
import { logJobTickFailure } from "./storage/job-tick.js";
import { HeartbeatPinger } from "./heartbeat.js";
import { VersionThinner } from "./storage/version-thinner.js";
import {
  TrashPurger,
  AuthSessionCleaner,
  PendingDeletePurger,
  RateLimitWindowCleaner,
  DcrClientCleaner,
  RuntimeCredentialReaper,
  runSpaceCleanup,
} from "./storage/retention.js";
import type { SpaceFanout } from "./storage/retention.js";
import { initEventLog, defaultCycleDetectionWiring } from "./pubsub.js";
import {
  createPgEventNotifier,
  startEventReplication,
  type EventReplication,
} from "./event-replication.js";
import { setConsentLockBackend } from "./auth/consent-lock.js";
import { createPgConsentLockBackend } from "./storage/pg/consent-lock-backend.js";
import type { PgClient, PgDb } from "./storage/pg/connection.js";
import { tryStartReactiveRunBridge } from "./connections/reactive-run-bridge.js";
import {
  tryStartLocalIntegrationRuntime,
  loadInTreeRegistrations,
  type LocalRuntimeBundle,
} from "./integrations/local-runtime/index.js";
import { DEFAULT_RUNTIME_CREDENTIAL_TTL_MS } from "./integrations/local-runtime/credentials.js";
import { TextEnrichmentSweeper } from "./enrichment/sweeper.js";
import { TesseractOcr } from "./enrichment/ocr.js";
import {
  startPgBossSchedules,
  type ScheduledJobSpec,
} from "./scheduled/pg-boss-schedules.js";
import type { PgBoss } from "pg-boss";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  log,
  formatErrorSummary,
  serializeError,
} from "./middleware/logger.js";
import { createEmailTransport } from "./email/index.js";
import { checkCorsOrigins } from "./routes/cors-origins-check.js";
import { checkMultiReplica } from "./multi-replica-check.js";
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

  // A database that is merely slow to come back (a rebooting host, a
  // pooler warming up) must not turn a supervised server into a crash
  // loop: wait with backoff inside the process, loudly, up to the budget.
  // Misconfiguration is not retryable and still fails immediately.
  const waitForDb = <T>(create: () => Promise<T>): Promise<T> =>
    withStartupWait(create, {
      budgetMs: config.dbStartupWaitMs ?? 90_000,
      onAttempt: (attempt, delayMs, err) => {
        log("warn", "Database not ready; waiting to retry", {
          attempt,
          retry_in_ms: delayMs,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

  let storage: Storage;
  if (config.storageDialect === "pg") {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required when DB_DIALECT=pg");
    }
    const databaseUrl = config.databaseUrl;
    const directUrl = config.databaseUrlDirect ?? "";
    storage = await waitForDb(() =>
      createPgStorage(databaseUrl, {
        authMode: config.authMode,
        directConnectionString: directUrl,
        poolMode: config.dbPoolMode,
      }),
    );
    // Which endpoint streaming RLS reserves from is not otherwise observable
    // from outside the process, and getting it wrong strands a role on shared
    // pooler backends, where it surfaces as permission errors on requests that
    // never touched a stream. State it once, at boot. Host only: connection
    // strings carry credentials.
    log("info", "Streaming RLS endpoint", {
      db_pool_mode: config.dbPoolMode ?? "session",
      streaming_endpoint: directUrl ? "direct" : "shared_with_app_pool",
      streaming_endpoint_host: pgEndpointHost(directUrl || config.databaseUrl),
    });
  } else {
    storage = await waitForDb(() =>
      createSqliteStorage(config.sqlitePath, {
        authMode: config.authMode,
      }),
    );
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
  // On Postgres every published event is announced to sibling processes
  // over pg_notify and their announcements are hydrated back into this
  // process's emitter (event-replication.ts), so SSE and the reactive
  // bridge see the whole deployment's events, not one process's. The
  // announcement rides the publishing transaction; the listener holds the
  // session-mode client, whose LISTEN connection postgres.js keeps apart
  // from the pool — one extra backend against the direct endpoint's
  // ceiling, not a pool slot. SQLite is one process and wires none of
  // this.
  const pgSessionClient =
    ((storage.pgStreamClient ?? storage.pgClient) as PgClient | undefined) ??
    null;
  initEventLog(storage.eventLog, {
    ...defaultCycleDetectionWiring(storage),
    ...(storage.pgDb !== undefined && {
      notifyRemote: createPgEventNotifier(storage.pgDb as PgDb),
    }),
  });
  let eventReplication: EventReplication | null = null;
  let consentLockClient: PgClient | null = null;
  if (pgSessionClient) {
    // A copy that cannot hear its siblings silently drops their events,
    // which is the exact defect this closes — a listen failure at boot is
    // fatal on purpose.
    eventReplication = await startEventReplication(
      pgSessionClient,
      storage.eventLog,
    );
    // The consent lock's cross-process backend: a blocking advisory lock
    // held for the critical section, so two web copies cannot interleave
    // grant read-modify-write cycles. It reserves from its own tiny
    // client, never a pool the critical section's own queries run on —
    // holding a lock connection from the pool the locked work needs is
    // the documented bracketing deadlock, reached at pool size. Session
    // mode is required (a session lock needs a session), so on a
    // transaction-mode pooler this takes the direct endpoint.
    const { default: postgresCtor } = await import("postgres");
    const sessionModeUrl =
      config.dbPoolMode === "transaction" && config.databaseUrlDirect
        ? config.databaseUrlDirect
        : config.databaseUrl;
    consentLockClient = postgresCtor(sessionModeUrl, {
      max: 2,
      idle_timeout: 30,
      max_lifetime: 30 * 60,
      onnotice: () => {
        // Advisory-lock warnings surface through the backend's own
        // destroy-on-doubt handling; the default notice logger is noise.
      },
    });
    setConsentLockBackend(createPgConsentLockBackend(consentLockClient));
  }

  // Opt-in via CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS + CLOUDFLARE_QUEUES_API_TOKEN;
  // returns null (self-hoster path) when either is unset.
  const reactiveRunBridge = tryStartReactiveRunBridge(storage, {
    sendTimeoutMs: config.reactiveRunSendTimeoutMs,
  });
  if (reactiveRunBridge) {
    void reactiveRunBridge
      .start()
      .then(() => {
        // Deliberately not "started": `start()` returns once the subscription
        // cache is loaded and the election has been kicked off, which says
        // nothing about whether this instance won it. The bridge logs the
        // election outcome itself, and that is the line that means events are
        // being forwarded.
        log("info", "Reactive-run bridge wired; awaiting election");
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

  // Declared ahead of the jobs rather than beside `shutdown()` because the
  // two inline cleanups below close over it: a sweep that loses its pool
  // because the process is going away is a cancellation, not a failure, and
  // this is the only thing that tells the two apart. Every other background
  // job carries the same flag on itself.
  let shuttingDown = false;

  // pg-boss carries two duties on Postgres: the scheduled background jobs
  // below, on every Postgres deployment, and the local integration
  // substrate's queues when that substrate is enabled. One instance serves
  // both. On a transaction-mode pooler it takes the direct endpoint, which
  // the boot guard guarantees is set: its core path tolerates a pooler,
  // but its schema migration deserves a connection that owns its backend,
  // and polling never benefits from pooling. The pool is bounded because
  // the direct endpoint has the tighter connection ceiling (see the
  // session pool's sizing note in storage/pg/connection.ts); a poll is a
  // fast statement, so many queues share two connections comfortably.
  let boss: PgBoss | null = null;
  if (config.storageDialect === "pg") {
    // pg-boss 12 is ESM with a named `PgBoss` export (no default).
    const { PgBoss: PgBossCtor } = await import("pg-boss");
    const bossUrl =
      config.dbPoolMode === "transaction" && config.databaseUrlDirect
        ? config.databaseUrlDirect
        : config.databaseUrl;
    boss = new PgBossCtor({ connectionString: bossUrl, max: 2 });
    // Maintenance errors surface on 'error'; an unhandled 'error' event
    // would crash the process over a transient the next tick absorbs.
    // Worker failures arrive as plain object literals carrying message,
    // stack, queue and worker fields, not Error instances, so the
    // instanceof arm alone would log "[object Object]" for exactly the
    // failures this channel exists to surface.
    boss.on("error", (err) => {
      const shaped = err as {
        message?: string;
        queue?: string;
        worker?: string;
      };
      log("error", "pg-boss error", {
        error:
          err instanceof Error ? err.message : (shaped.message ?? String(err)),
        ...(shaped.queue !== undefined && { queue: shaped.queue }),
        ...(shaped.worker !== undefined && { worker: shaped.worker }),
      });
    });
    await boss.start();
  }

  // On Postgres the recurring background jobs run as pg-boss chains
  // (scheduled/pg-boss-schedules.ts), so exactly one process executes each
  // tick however many share the database, and — once containers split by
  // role — the queue is what pins this work to the worker container. On
  // SQLite each job keeps its own in-process timer: pg-boss is
  // Postgres-only, and a SQLite deployment is single-process by
  // definition. Every job construction below routes through this helper.
  const scheduledJobs: ScheduledJobSpec[] = [];
  const scheduleJob = (
    spec: ScheduledJobSpec,
    startTimer: () => void,
  ): void => {
    if (boss) scheduledJobs.push(spec);
    else startTimer();
  };

  const auditFanout: SpaceFanout | undefined = storage.spaces
    ? { spaces: storage.spaces, configField: "audit_retention_days" }
    : undefined;
  const eventLogFanout: SpaceFanout | undefined = storage.spaces
    ? { spaces: storage.spaces, configField: "event_log_retention_hours" }
    : undefined;
  const trashFanout: SpaceFanout | undefined = storage.spaces
    ? { spaces: storage.spaces, configField: "trash_retention_days" }
    : undefined;

  // Default 168h; override via MARFA_EVENT_LOG_RETENTION_HOURS or per-space config.
  const eventLogRetentionHours = config.eventLogRetentionHours ?? 168;
  const runEventLogCleanup = () =>
    runSpaceCleanup({
      jobName: "event-log-cleanup",
      coordination: storage.coordination,
      fanout: eventLogFanout,
      instanceDefault: eventLogRetentionHours,
      unitMs: 3_600_000,
      sweep: (retention, spaceId) =>
        storage.eventLog.cleanup(retention, spaceId),
    })
      .then((deleted) => {
        if (deleted > 0)
          log(
            "info",
            `Purged ${String(deleted)} event_log entries (instance default: ${String(eventLogRetentionHours)} hours; per-space overrides honored)`,
          );
      })
      .catch((err: unknown) => {
        logJobTickFailure("Event-log cleanup", err, shuttingDown);
      });
  let eventLogCleanupDelay: ReturnType<typeof setTimeout> | null = null;
  let eventLogCleanupInterval: ReturnType<typeof setInterval> | null = null;
  scheduleJob(
    {
      name: "event-log-cleanup",
      logName: "Event-log cleanup",
      intervalMs: config.eventLogCleanupIntervalMs ?? 3_600_000,
      firstRunDelaySeconds: 10,
      runOnce: runEventLogCleanup,
    },
    () => {
      eventLogCleanupDelay = setTimeout(
        () => void runEventLogCleanup(),
        10_000,
      );
      eventLogCleanupInterval = setInterval(
        () => void runEventLogCleanup(),
        config.eventLogCleanupIntervalMs ?? 3_600_000,
      );
    },
  );

  const runAuditCleanup = () =>
    runSpaceCleanup({
      jobName: "audit-cleanup",
      coordination: storage.coordination,
      fanout: auditFanout,
      instanceDefault: config.auditRetentionDays,
      unitMs: 86_400_000,
      sweep: (retention, spaceId) => storage.audit.cleanup(retention, spaceId),
    })
      .then((deleted) => {
        if (deleted > 0)
          log(
            "info",
            `Purged ${String(deleted)} audit entries (instance default: ${String(config.auditRetentionDays)} days; per-space overrides honored)`,
          );
      })
      .catch((err: unknown) => {
        logJobTickFailure("Audit cleanup", err, shuttingDown);
      });
  let auditCleanupDelay: ReturnType<typeof setTimeout> | null = null;
  let auditCleanupInterval: ReturnType<typeof setInterval> | null = null;
  scheduleJob(
    {
      name: "audit-cleanup",
      logName: "Audit cleanup",
      intervalMs: config.auditCleanupIntervalMs,
      firstRunDelaySeconds: 5,
      runOnce: runAuditCleanup,
    },
    () => {
      auditCleanupDelay = setTimeout(() => void runAuditCleanup(), 5_000);
      auditCleanupInterval = setInterval(
        () => void runAuditCleanup(),
        config.auditCleanupIntervalMs,
      );
    },
  );

  const webhookConsumer = new WebhookConsumer(
    storage.outboundWebhooks,
    storage.outboundWebhookDeliveries,
  );
  webhookConsumer.start();

  const webhookPoller = new WebhookPoller(storage.outboundWebhookDeliveries);
  // The one background job with no cross-process coordination of its own:
  // two timer-driven copies double-deliver, which is why this job in
  // particular must run through the queue on Postgres.
  scheduleJob(
    {
      name: "webhook-poll",
      logName: "Webhook poll",
      intervalMs: WEBHOOK_POLL_INTERVAL_MS,
      runOnce: () => webhookPoller.runOnce(),
    },
    () => {
      webhookPoller.start();
    },
  );

  // Opt-in liveness heartbeat: off unless the operator names a receiver.
  const heartbeat = config.heartbeatUrl
    ? new HeartbeatPinger(
        config.heartbeatUrl,
        config.heartbeatIntervalMs ?? 60_000,
      )
    : null;
  heartbeat?.start();

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
  scheduleJob(
    {
      name: "version-thinning",
      logName: "Version thinning",
      intervalMs: config.versionThinningIntervalMs,
      firstRunDelaySeconds: 15,
      runOnce: () => versionThinner.runOnce(),
    },
    () => {
      versionThinner.start();
    },
  );

  const trashPurger = new TrashPurger(
    storage.items,
    config.trashRetentionDays,
    config.trashPurgeIntervalMs,
    undefined,
    storage.coordination,
    trashFanout,
  );
  scheduleJob(
    {
      name: "trash-purge",
      logName: "Trash purge",
      intervalMs: config.trashPurgeIntervalMs,
      firstRunDelaySeconds: 20,
      runOnce: () => trashPurger.runScheduled(),
    },
    () => {
      trashPurger.start();
    },
  );

  // Gated on authSessions being wired; test contexts that skip better-auth omit it.
  const authSessionCleaner = storage.authSessions
    ? new AuthSessionCleaner(
        storage.authSessions,
        config.authSessionCleanupIntervalMs ?? 3_600_000,
        undefined,
        storage.coordination,
      )
    : undefined;
  if (authSessionCleaner) {
    scheduleJob(
      {
        name: "auth-session-cleanup",
        logName: "Auth session cleanup",
        intervalMs: config.authSessionCleanupIntervalMs ?? 3_600_000,
        firstRunDelaySeconds: 25,
        runOnce: () => authSessionCleaner.runScheduled(),
      },
      () => {
        authSessionCleaner.start();
      },
    );
  }

  // Gated on accountLifecycle being wired; test stubs that omit it skip this job.
  const pendingDeletePurger = storage.accountLifecycle
    ? new PendingDeletePurger(
        storage,
        config.accountDeletionGraceDays ?? 30,
        config.accountDeletionPurgeIntervalMs ?? 3_600_000,
        undefined,
        storage.coordination,
      )
    : undefined;
  if (pendingDeletePurger) {
    scheduleJob(
      {
        name: "account-deletion-purge",
        logName: "Pending-delete purge",
        intervalMs: config.accountDeletionPurgeIntervalMs ?? 3_600_000,
        firstRunDelaySeconds: 30,
        runOnce: () => pendingDeletePurger.runScheduled(),
      },
      () => {
        pendingDeletePurger.start();
      },
    );
  }

  // GC keeps the table bounded; expired rows are correctness-safe (upsert path
  // overwrites them transparently).
  const rateLimitCleaner = new RateLimitWindowCleaner(
    storage,
    config.rateLimitCleanupIntervalMs ?? 3_600_000,
    undefined,
    storage.coordination,
  );
  scheduleJob(
    {
      name: "rate-limit-cleanup",
      logName: "Rate-limit window cleanup",
      intervalMs: config.rateLimitCleanupIntervalMs ?? 3_600_000,
      firstRunDelaySeconds: 25,
      runOnce: () => rateLimitCleaner.runScheduled(),
    },
    () => {
      rateLimitCleaner.start();
    },
  );

  // Reap grantless DCR clients so unauthenticated registration doesn't grow
  // `auth_oauth_client` unbounded. Gated on a positive retention window
  // (`0` disables) and on the oauth-provider store being wired (test
  // contexts that skip better-auth omit it).
  const dcrRetentionDays = config.dcrClientRetentionDays ?? 30;
  const dcrClientCleaner =
    dcrRetentionDays > 0 && storage.oauthProvider
      ? new DcrClientCleaner(
          storage,
          dcrRetentionDays,
          config.dcrClientCleanupIntervalMs ?? 86_400_000,
          undefined,
          storage.coordination,
        )
      : undefined;
  if (dcrClientCleaner) {
    scheduleJob(
      {
        name: "dcr-client-cleanup",
        logName: "DCR client cleanup",
        intervalMs: config.dcrClientCleanupIntervalMs ?? 86_400_000,
        firstRunDelaySeconds: 30,
        runOnce: () => dcrClientCleaner.runScheduled(),
      },
      () => {
        dcrClientCleaner.start();
      },
    );
  }

  // Runtime credentials are minted per dispatch, so the table grows with
  // traffic unless something retires them. The mint path supersedes its own
  // siblings and the bearer gate refuses expired rows, but neither reaches
  // credentials for connections that stopped dispatching, nor rows minted
  // before expiry stamping existed. Interval `0` disables the job.
  const runtimeCredentialReaperIntervalMs =
    config.runtimeCredentialReaperIntervalMs ?? 3_600_000;
  const runtimeCredentialReaper =
    runtimeCredentialReaperIntervalMs > 0
      ? new RuntimeCredentialReaper(
          storage,
          DEFAULT_RUNTIME_CREDENTIAL_TTL_MS,
          runtimeCredentialReaperIntervalMs,
          undefined,
          storage.coordination,
        )
      : undefined;
  if (runtimeCredentialReaper) {
    scheduleJob(
      {
        name: "runtime-credential-reap",
        logName: "Runtime credential reap",
        intervalMs: runtimeCredentialReaperIntervalMs,
        firstRunDelaySeconds: 30,
        runOnce: () => runtimeCredentialReaper.runScheduled(),
      },
      () => {
        runtimeCredentialReaper.start();
      },
    );
  }

  // Text extraction from uploaded files, on by default: a document nobody
  // can find is barely stored. The OCR engine is constructed eagerly but
  // loads nothing until an image actually reaches it.
  const enrichmentSweeper =
    config.enrichmentEnabled !== false
      ? new TextEnrichmentSweeper({
          storage,
          blobs: blobBackend,
          ocr:
            config.enrichmentOcrEnabled !== false
              ? new TesseractOcr({
                  cachePath: config.enrichmentTessdataDir ?? "./data/tessdata",
                })
              : null,
          intervalMs: config.enrichmentIntervalMs ?? 30_000,
          batchSize: config.enrichmentBatchSize ?? 8,
          itemTimeoutMs: config.enrichmentItemTimeoutMs ?? 60_000,
          maxBlobBytes: config.enrichmentMaxBlobBytes ?? 20 * 1024 * 1024,
          maxTextChars: config.enrichmentMaxTextChars ?? 200_000,
          maxAttempts: config.enrichmentMaxAttempts ?? 3,
        })
      : undefined;
  if (enrichmentSweeper) {
    scheduleJob(
      {
        name: "enrichment-sweep",
        logName: "Text enrichment sweep",
        intervalMs: config.enrichmentIntervalMs ?? 30_000,
        firstRunDelaySeconds: 15,
        // A tick is a batch of per-item extractions, each with its own
        // 60s OCR budget, so a legitimate tick can far outrun twice the
        // 30s interval the default expiry would allow.
        expireInSeconds:
          Math.ceil(
            ((config.enrichmentBatchSize ?? 8) *
              (config.enrichmentItemTimeoutMs ?? 60_000)) /
              1000,
          ) + 120,
        runOnce: () => enrichmentSweeper.runScheduled(),
      },
      () => {
        enrichmentSweeper.start();
      },
    );
  }

  const bulkActionWorker = new BulkActionWorker({
    storage,
    pollIntervalMs: config.bulkActionPollIntervalMs ?? 500,
    maxPollIntervalMs: config.bulkActionPollMaxIntervalMs ?? 60_000,
    pollBackoffMultiplier: config.bulkActionPollBackoffMultiplier ?? 2,
  });
  // Enqueue wakes the worker. The route cannot hold a worker reference —
  // the app is constructed before the worker exists — so the signal is
  // registered here, where both are in scope.
  setBulkJobEnqueueListener(() => {
    bulkActionWorker.wake();
  });
  await bulkActionWorker.start();
  const bulkActionGc = new BulkActionJobGcSweeper(
    storage,
    config.bulkActionJobRetentionMs ?? 7 * 24 * 3_600_000,
    config.bulkActionJobGcIntervalMs ?? 3_600_000,
    undefined,
    storage.coordination,
  );
  // Gated the same way the sweeper's own start() gates itself: a zero or
  // negative retention disables the job, and a queue chain for a job that
  // always answers zero would tick forever for nothing.
  if ((config.bulkActionJobRetentionMs ?? 7 * 24 * 3_600_000) > 0) {
    scheduleJob(
      {
        name: "bulk-action-jobs-gc",
        logName: "Bulk-action job GC",
        intervalMs: config.bulkActionJobGcIntervalMs ?? 3_600_000,
        firstRunDelaySeconds: 30,
        runOnce: () => bulkActionGc.runOnce(),
      },
      () => {
        bulkActionGc.start();
      },
    );
  }

  // Register the queue workers and seed the chains once every job above
  // has contributed its spec. Idempotent across processes and restarts.
  if (boss) {
    await startPgBossSchedules(boss, scheduledJobs, {
      isShuttingDown: () => shuttingDown,
    });
    log("info", "Scheduled jobs running on pg-boss", {
      jobs: scheduledJobs.length,
    });
  }

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
    authMode: config.authMode,
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

  const oidcSigner = await OidcSigner.init(storage);

  // Integrations: the local substrate (Node + pg-boss) runs in-process; the
  // hosted substrate delegates to Cloudflare. Default is "local". The local
  // substrate needs Postgres, so on SQLite we skip it rather than crash the
  // zero-config quickstart.
  let localRuntime: LocalRuntimeBundle | null = null;
  if ((config.integrationRuntime ?? "local") === "local") {
    if (config.storageDialect !== "pg") {
      // Don't construct pg-boss against a SQLite (empty) connection string —
      // that crashes boot. Skip with a log instead. Warn when the operator
      // asked for local explicitly; info when it merely defaulted (the SQLite
      // zero-config quickstart path) so a first run stays clean.
      const explicit = process.env.MARFA_INTEGRATION_RUNTIME === "local";
      log(
        explicit ? "warn" : "info",
        explicit
          ? "MARFA_INTEGRATION_RUNTIME=local requires DB_DIALECT=pg; integrations are disabled. " +
              "Switch to Postgres, or set MARFA_INTEGRATION_RUNTIME=hosted for the Cloudflare substrate."
          : "Integrations are off: the local substrate needs Postgres and this instance is on SQLite. " +
              "Set DB_DIALECT=pg to enable in-process integrations, or MARFA_INTEGRATION_RUNTIME=hosted for the Cloudflare substrate.",
      );
    } else {
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
        // The shared pg-boss instance always exists on this branch: it is
        // constructed for every Postgres deployment above (with the
        // direct-endpoint and bounded-pool handling that used to live
        // here), and this block is unreachable on SQLite.
        if (!boss) {
          throw new Error(
            "pg-boss instance missing on a Postgres deployment; the shared instance should have been constructed at boot",
          );
        }
        localRuntime = await tryStartLocalIntegrationRuntime({
          storage,
          config,
          registrations,
          boss,
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
  }

  // Boot guard: warn loud if hosted mode runs with an empty CORS allowlist —
  // browser clients would fail their cross-origin API calls with no obvious
  // cause. A warning, not a hard stop (API-only hosted deployments are fine).
  checkCorsOrigins({
    authMode: config.authMode,
    corsOrigins: config.corsOrigins,
  });

  // Boot guard: warn loud when several server processes appear to share one
  // database. Realtime delivery is process-local, so the extra processes drop
  // events silently — nothing surfaces at the API, so nothing else would say.
  checkMultiReplica();

  const app = createApp(
    storage,
    blobBackend,
    config,
    emailTransport,
    oidcSigner,
    localRuntime?.app,
    localRuntime?.deadLetterOps,
  );

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("info", `Marfa server listening on port ${String(info.port)}`);
  });

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
    webhookPoller.stop();
    heartbeat?.stop();
    if (eventReplication) {
      // Unlisten is a courtesy to the connection; the storage close below
      // ends it regardless, so a failure here changes nothing.
      void eventReplication.stop().catch(() => undefined);
    }
    if (consentLockClient) {
      void consentLockClient.end({ timeout: 5 }).catch(() => undefined);
    }
    // Null on Postgres, where these jobs ran through pg-boss instead of
    // timers; their queued chains persist across the restart by design.
    if (eventLogCleanupDelay) clearTimeout(eventLogCleanupDelay);
    if (eventLogCleanupInterval) clearInterval(eventLogCleanupInterval);
    if (auditCleanupDelay) clearTimeout(auditCleanupDelay);
    if (auditCleanupInterval) clearInterval(auditCleanupInterval);
    versionThinner.stop();
    trashPurger.stop();
    authSessionCleaner?.stop();
    pendingDeletePurger?.stop();
    rateLimitCleaner.stop();
    dcrClientCleaner?.stop();
    runtimeCredentialReaper?.stop();
    enrichmentSweeper?.stop();
    bulkActionWorker.stop();
    bulkActionGc.stop();
    if (reactiveRunBridge) {
      void reactiveRunBridge.stop().catch(() => {
        // Swallowed — the coordination lock releases with the connection anyway.
      });
    }
    // pg-boss's stop must be AWAITED: its graceful path runs failWip only
    // after in-flight handlers settle, and failWip is what frees each
    // job's active slot so the queued successor is fetchable on the next
    // boot. Fire-and-forget here loses that race to process.exit below,
    // and every deploy then stalls each mid-tick job until its
    // expireInSeconds elapses.
    if (localRuntime) {
      void localRuntime.bridge.stop().catch(() => undefined);
      await localRuntime.runtime.stop().catch(() => undefined);
    } else if (boss) {
      // The supervisor's stop() drains the shared pg-boss when the local
      // runtime is up; with the hosted substrate only the scheduled jobs
      // ride it, so it is stopped here instead.
      await boss
        .stop({ graceful: true, timeout: 5_000 })
        .catch(() => undefined);
    }

    let exitCode = 0;
    try {
      await withTimeout(closeServer(server), SHUTDOWN_STEP_TIMEOUT_MS);
      await withTimeout(storage.close(), SHUTDOWN_STEP_TIMEOUT_MS);
    } catch (error) {
      log("warn", "Graceful shutdown did not complete", {
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
