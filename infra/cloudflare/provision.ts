/**
 * Idempotent Cloudflare environment provisioning for the Connections
 * runtime. Run once per environment (`dev`, `staging`, `prod`); safe to
 * re-run.
 *
 * Usage:
 *   pnpm --filter @mymehq/infra-cloudflare provision dev
 *   pnpm --filter @mymehq/infra-cloudflare provision staging
 *   pnpm --filter @mymehq/infra-cloudflare provision prod
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN   — token with Workers/Queues/KV/R2 write
 *   CLOUDFLARE_ACCOUNT_ID  — account containing the runtime
 *
 * Optional env (named-tunnel DNS routing — see README):
 *   CLOUDFLARE_ZONE_ID     — zone to attach the tunnel CNAME to
 *
 * Resources created:
 *   - Queues:  myme-webhook-receipt-<env>, myme-scheduled-poll-<env>,
 *              myme-reactive-run-<env> (+ -dlq variants)
 *   - Per-integration reactive-run queues (T-233):
 *              myme-reactive-run-<integration>-<env> (+ -dlq)
 *              for every integration in REACTIVE_RUN_INTEGRATIONS that
 *              declares an `item-event` trigger.
 *   - Per-integration webhook-receipt queues (T-247):
 *              myme-webhook-receipt-<integration>-<env> (+ -dlq)
 *              for every integration in WEBHOOK_RECEIVING_INTEGRATIONS
 *              that declares a `webhook` trigger.
 *   - Per-integration scheduled-poll queues (T-240):
 *              myme-scheduled-poll-<integration>-<env> (+ -dlq)
 *              for every integration in SCHEDULED_POLL_INTEGRATIONS that
 *              declares a `schedule` trigger.
 *   - KV:      myme-control-idempotency-<env>
 *   - R2:      myme-runtime-payloads-<env>
 *
 * Tunnel DNS automation is left to the operator for now (see
 * tunnel.config.example.yml). The current account-scoped token does
 * not carry zone-edit; provision.ts prints clear instructions if asked
 * to do tunnel work and the scope is missing.
 */
import { CloudflareClient } from "./cloudflare-api.js";

type Env = "dev" | "staging" | "prod";

function isEnv(s: string): s is Env {
  return s === "dev" || s === "staging" || s === "prod";
}

/**
 * T-233 — the set of in-tree integrations that consume reactive
 * `item-event` envelopes on the hosted substrate. Each entry gets its
 * own `myme-reactive-run-<integration>-<env>` queue (+ DLQ); the
 * server's `reactive-run-bridge` routes envelopes per `integration_name`
 * to the matching producer URL (env var
 * `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS`).
 *
 * Hardcoded rather than derived from `integrations/<name>/src/manifest.ts`
 * because the set is small + stable, and the alternative (TS-parse the
 * manifest source to find `triggers.item-event`) adds a script-side
 * build dependency this lean provisioner doesn't carry. Add an entry
 * whenever a new integration with an `item-event` trigger lands.
 *
 * Hosted-only — `mymehq.sync` is local-only (no Cloudflare deploy), so
 * not in this list. `mymehq.github-webhooks` and `mymehq.rss-watcher`
 * have no `item-event` trigger.
 */
const REACTIVE_RUN_INTEGRATIONS = [
  "mymehq.task-auto-archive",
  "google.calendar",
  "google.tasks",
  "google.drive",
  "google.contacts",
  "todoist.tasks",
] as const;

/**
 * T-247 — integrations whose manifest declares a `webhook` trigger and
 * which consume from a dedicated per-integration webhook-receipt queue
 * (one consumer per CF queue; see the `pickDedicatedProducer` switch
 * in `packages/runtime-control/src/routes/webhooks.ts`).
 *
 * `mymehq.github-webhooks` is intentionally absent: it still consumes
 * the legacy shared `myme-webhook-receipt-<env>` queue via the
 * fallback path in the resolver. Migrating it to a dedicated queue is
 * a follow-up that needs both a binding flip on the control plane and
 * a consumer-queue switch on the github-webhooks Worker side.
 */
const WEBHOOK_RECEIVING_INTEGRATIONS = [
  "mymehq.inbox",
  "google.calendar",
  "google.drive",
] as const;

/**
 * T-240 — integrations whose manifest declares a `schedule` trigger.
 * Each consumes its own dedicated scheduled-poll queue; the
 * provisioner mints both the queue and its DLQ.
 *
 * **Queue-slug shape is per-integration** because the existing
 * consumer-side `wrangler.toml` entries are inconsistent on whether
 * they keep the publisher prefix:
 *   - directory-named (no publisher prefix): rss-watcher,
 *     task-auto-archive, raindrop, readwise
 *   - manifest-named (dot replaced with hyphen): todoist-tasks,
 *     google-calendar, google-tasks, google-drive, google-contacts,
 *     google-youtube
 *
 * The slug here matches what the consumer wrangler.toml already
 * declares — anything else would mint queues no one listens on.
 * PR2 (T-261, manifest-driven derivation) normalises this.
 */
const SCHEDULED_POLL_INTEGRATIONS = [
  { name: "google.calendar", slug: "google-calendar" },
  { name: "google.tasks", slug: "google-tasks" },
  { name: "google.drive", slug: "google-drive" },
  { name: "google.contacts", slug: "google-contacts" },
  { name: "google.youtube", slug: "google-youtube" },
  { name: "raindrop.bookmarks", slug: "raindrop" },
  { name: "readwise.highlights", slug: "readwise" },
  { name: "mymehq.rss-watcher", slug: "rss-watcher" },
  { name: "mymehq.task-auto-archive", slug: "task-auto-archive" },
  { name: "todoist.tasks", slug: "todoist-tasks" },
] as const;

/**
 * Cloudflare Queue names must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`
 * (no dots). The publisher-namespaced manifest name (e.g.
 * `mymehq.task-auto-archive`, `google.calendar`) carries a dot, so the
 * provisioner lowercases + replaces every dot with a hyphen to derive
 * the queue-name slug — same shape already used by the existing
 * `myme-scheduled-poll-<slug>-<env>` and
 * `myme-webhook-receipt-<slug>-<env>` queues.
 *
 *   "mymehq.task-auto-archive" → "mymehq-task-auto-archive"
 *   "google.calendar"          → "google-calendar"
 */
function queueSlug(integrationName: string): string {
  return integrationName.toLowerCase().replace(/\./g, "-");
}

interface ResourceIds {
  queues: Record<string, string>;
  kv: Record<string, string>;
  r2: string[];
}

async function provisionQueues(
  client: CloudflareClient,
  env: Env,
  out: ResourceIds,
): Promise<void> {
  const wanted = [
    `myme-webhook-receipt-${env}`,
    `myme-webhook-receipt-${env}-dlq`,
    `myme-scheduled-poll-${env}`,
    `myme-scheduled-poll-${env}-dlq`,
    // The shared `myme-reactive-run-${env}` (+ DLQ) is the legacy
    // single-consumer queue. T-233 splits per integration; the shared
    // queue + DLQ stay declared here for backward-compat through the
    // task-auto-archive migration window. Once PR3 drains it, the
    // shared queue can be removed from this list.
    `myme-reactive-run-${env}`,
    `myme-reactive-run-${env}-dlq`,
  ];
  // T-233 — per-integration reactive-run queues. Each integration with
  // an `item-event` trigger gets its own queue + DLQ; the server's
  // bridge routes envelopes per `integration_name` to the matching
  // queue URL. The integration name's publisher dot is replaced with
  // a hyphen for the queue slug because Cloudflare Queues reject dot
  // characters in queue names.
  for (const integration of REACTIVE_RUN_INTEGRATIONS) {
    const slug = queueSlug(integration);
    wanted.push(`myme-reactive-run-${slug}-${env}`);
    wanted.push(`myme-reactive-run-${slug}-${env}-dlq`);
  }
  // T-247 — per-integration webhook-receipt queues. Each integration
  // with a `webhook` trigger gets its own queue + DLQ; the control
  // plane's webhook route resolves a per-integration producer binding
  // and writes verified deliveries there (single-consumer pattern).
  for (const integration of WEBHOOK_RECEIVING_INTEGRATIONS) {
    const slug = queueSlug(integration);
    wanted.push(`myme-webhook-receipt-${slug}-${env}`);
    wanted.push(`myme-webhook-receipt-${slug}-${env}-dlq`);
  }
  // T-240 — per-integration scheduled-poll queues. Each integration
  // with a `schedule` trigger gets its own queue + DLQ; the
  // integration's own Worker consumes from it on each cron tick. The
  // slug here intentionally bypasses `queueSlug()` because some
  // consumer wrangler.toml entries dropped the publisher prefix (see
  // SCHEDULED_POLL_INTEGRATIONS comment for the inconsistency).
  for (const { slug } of SCHEDULED_POLL_INTEGRATIONS) {
    wanted.push(`myme-scheduled-poll-${slug}-${env}`);
    wanted.push(`myme-scheduled-poll-${slug}-${env}-dlq`);
  }
  const existing = await client.listQueues();
  const existingByName = new Map(existing.map((q) => [q.queue_name, q]));

  for (const name of wanted) {
    const found = existingByName.get(name);
    if (found) {
      out.queues[name] = found.queue_id;
      console.log(`[queues] ✓ ${name} (existing) ${found.queue_id}`);
      continue;
    }
    const created = await client.createQueue(name);
    out.queues[name] = created.queue_id;
    console.log(`[queues] + ${name} (created) ${created.queue_id}`);
  }
}

async function provisionDlqHttpPull(
  client: CloudflareClient,
  env: Env,
  out: ResourceIds,
): Promise<void> {
  // Only the 3 central per-kind DLQs that the runtime-control DLQ peek
  // route addresses (packages/runtime-control/src/routes/dlq.ts).
  // Integration-specific DLQs aren't reachable via /dlq/peek and don't
  // need http_pull. Idempotent — list existing consumers first; only add
  // when none of type http_pull is registered.
  const wantedDlqs = [
    `myme-webhook-receipt-${env}-dlq`,
    `myme-scheduled-poll-${env}-dlq`,
    `myme-reactive-run-${env}-dlq`,
  ];
  for (const name of wantedDlqs) {
    const queueId = out.queues[name];
    if (!queueId) {
      console.warn(`[http-pull] ! ${name} (skipped — queue not provisioned)`);
      continue;
    }
    const existing = await client.listQueueHttpConsumers(queueId);
    const first = existing[0];
    if (first) {
      console.log(
        `[http-pull] ✓ ${name} (existing consumer ${first.consumer_id})`,
      );
      continue;
    }
    const created = await client.addQueueHttpConsumer(queueId);
    console.log(
      `[http-pull] + ${name} (created consumer ${created.consumer_id})`,
    );
  }
}

async function provisionKv(
  client: CloudflareClient,
  env: Env,
  out: ResourceIds,
): Promise<void> {
  const wanted = [`myme-control-idempotency-${env}`];
  const existing = await client.listKvNamespaces();
  const existingByName = new Map(existing.map((n) => [n.title, n]));

  for (const title of wanted) {
    const found = existingByName.get(title);
    if (found) {
      out.kv[title] = found.id;
      console.log(`[kv]     ✓ ${title} (existing) ${found.id}`);
      continue;
    }
    const created = await client.createKvNamespace(title);
    out.kv[title] = created.id;
    console.log(`[kv]     + ${title} (created) ${created.id}`);
  }
}

async function provisionR2(
  client: CloudflareClient,
  env: Env,
  out: ResourceIds,
): Promise<void> {
  const wanted = [`myme-runtime-payloads-${env}`];
  const existing = await client.listR2Buckets();
  const existingByName = new Set(existing.map((b) => b.name));

  for (const name of wanted) {
    if (existingByName.has(name)) {
      out.r2.push(name);
      console.log(`[r2]     ✓ ${name} (existing)`);
      continue;
    }
    try {
      await client.createR2Bucket(name);
      out.r2.push(name);
      console.log(`[r2]     + ${name} (created)`);
    } catch (err) {
      // Most likely cause: account-scoped token lacks R2 write OR R2
      // hasn't been enabled for the account. Surface clearly; do not
      // abort other provisioning steps.
      console.warn(
        `[r2]     ! ${name} (skipped) ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function checkTunnelScope(): void {
  if (!process.env.CLOUDFLARE_ZONE_ID) {
    console.log("");
    console.log("[tunnel] CLOUDFLARE_ZONE_ID not set; skipping DNS routing.");
    console.log(
      "[tunnel]   Named-tunnel DNS automation requires zone-edit scope on",
    );
    console.log(
      "[tunnel]   the API token. Either extend the token's scope OR create",
    );
    console.log(
      "[tunnel]   the CNAME manually (runtime[-staging].myme.so → tunnel uuid).",
    );
    console.log(
      "[tunnel]   See infra/cloudflare/tunnel.config.example.yml for context.",
    );
  }
}

async function main(): Promise<void> {
  const envArg = process.argv[2];
  if (!envArg || !isEnv(envArg)) {
    console.error("Usage: pnpm provision <dev|staging|prod>");
    process.exit(1);
  }
  const env: Env = envArg;

  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    console.error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in env.",
    );
    process.exit(1);
  }

  const client = new CloudflareClient({ apiToken, accountId });
  const out: ResourceIds = { queues: {}, kv: {}, r2: [] };

  console.log(`Provisioning Cloudflare resources for env="${env}" …`);
  console.log("");

  await provisionQueues(client, env, out);
  console.log("");
  await provisionDlqHttpPull(client, env, out);
  console.log("");
  await provisionKv(client, env, out);
  console.log("");
  await provisionR2(client, env, out);
  console.log("");

  checkTunnelScope();

  console.log("");
  console.log("Done. Resource IDs (for wrangler.*.toml bindings):");
  console.log(JSON.stringify(out, null, 2));

  // T-233 — pre-built CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS map for the
  // server's env. The server reads this at boot to route reactive item-
  // event envelopes per `integration_name` (see
  // packages/server/src/connections/reactive-run-bridge.ts). Operator
  // pastes the value below into the staging/prod env (Atlas plist, K8s
  // secret, etc.). One URL per integration; new integrations need an
  // entry in REACTIVE_RUN_INTEGRATIONS at the top of this script + a
  // re-run.
  const reactiveRunUrls: Record<string, string> = {};
  for (const integration of REACTIVE_RUN_INTEGRATIONS) {
    const queueName = `myme-reactive-run-${queueSlug(integration)}-${env}`;
    const queueId = out.queues[queueName];
    if (!queueId) {
      console.warn(
        `[reactive-urls] ! ${integration}: queue ${queueName} not provisioned; skipping URL entry`,
      );
      continue;
    }
    // Map key is the FULL integration_name (with dot) — that's what
    // the server's bridge resolver looks up against the envelope's
    // `integration_name` field. Queue NAME drops the dot for CF's
    // naming rule; the URL embeds the queue ID, not the name.
    reactiveRunUrls[integration] =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`;
  }
  console.log("");
  console.log(
    "T-233 — CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS (paste into server env):",
  );
  console.log(JSON.stringify(reactiveRunUrls));
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
