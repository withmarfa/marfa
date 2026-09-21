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
import { setBusyBudgetMs } from "./storage/sqlite/connection.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import type { Storage } from "./storage/interface.js";
import { WebhookConsumer } from "./webhooks/delivery.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { registerHousekeepingJobs } from "./housekeeping/registrations.js";
import { initEventLog } from "./pubsub.js";
import {
  log,
  formatErrorSummary,
  serializeError,
} from "./middleware/logger.js";
import {
  BulkActionWorker,
  setBulkJobEnqueueListener,
} from "./bulk-actions/index.js";
import { shutdownInOrder } from "./shutdown.js";

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

  const webhookConsumer = new WebhookConsumer(
    storage.outboundWebhooks,
    storage.outboundWebhookDeliveries,
  );
  webhookConsumer.start();

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
    // exporting it would put the key to the instance in whatever sink
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

  const app = createApp(storage, blobs, housekeeping, config, instanceId);
  await housekeeping.start();
  log("info", "Housekeeping started", { names: housekeeping.names() });
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
    void shutdownInOrder({
      webhookConsumer,
      bulkActionWorker,
      housekeeping,
      server,
      storage,
      // No-op when OTel is disabled. Accessed via an inline cast rather than
      // the ambient `declare global` so the per-entry .d.ts build stays typed.
      flushTelemetry: (
        globalThis as { __marfaOtelShutdown?: () => Promise<void> }
      ).__marfaOtelShutdown,
    }).then((exitCode) => {
      process.exit(exitCode);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
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
