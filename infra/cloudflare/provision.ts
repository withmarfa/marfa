/**
 * Idempotent Cloudflare environment provisioning for the Connections
 * runtime. Run once per environment (`dev`, `staging`, `prod`); safe to
 * re-run.
 *
 * Usage:
 *   pnpm --filter @withmarfa/infra-cloudflare provision dev
 *   pnpm --filter @withmarfa/infra-cloudflare provision staging
 *   pnpm --filter @withmarfa/infra-cloudflare provision prod
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN   — token with Workers/Queues/KV/R2 write
 *   CLOUDFLARE_ACCOUNT_ID  — account containing the runtime
 *
 * Optional env (named-tunnel DNS routing — see README):
 *   CLOUDFLARE_ZONE_ID     — zone to attach the tunnel CNAME to
 *
 * Resources created:
 *   - Queues:  marfa-webhook-receipt-<env>, marfa-scheduled-poll-<env>,
 *              marfa-reactive-run-<env> (+ -dlq variants)
 *   - Per-integration reactive-run queues:
 *              marfa-reactive-run-<integration>-<env> (+ -dlq)
 *              for every integration in REACTIVE_RUN_INTEGRATIONS that
 *              declares an `item-event` trigger.
 *   - Per-integration webhook-receipt queues:
 *              marfa-webhook-receipt-<integration>-<env> (+ -dlq)
 *              for every integration in WEBHOOK_RECEIVING_INTEGRATIONS
 *              that declares a `webhook` trigger.
 *   - Per-integration scheduled-poll queues:
 *              marfa-scheduled-poll-<integration>-<env> (+ -dlq)
 *              for every integration in SCHEDULED_POLL_INTEGRATIONS that
 *              declares a `schedule` trigger.
 *   - KV:      marfa-control-idempotency-<env>
 *   - R2:      marfa-runtime-payloads-<env>
 *
 * Tunnel DNS automation is left to the operator for now (see
 * tunnel.config.example.yml). The current account-scoped token does
 * not carry zone-edit; provision.ts prints clear instructions if asked
 * to do tunnel work and the scope is missing.
 */
import {
  integrationsWithTrigger,
  scheduledPollSlugFor,
} from "@withmarfa/shared";
import { CloudflareClient } from "./cloudflare-api.js";

type Env = "dev" | "staging" | "prod";

function isEnv(s: string): s is Env {
  return s === "dev" || s === "staging" || s === "prod";
}

/**
 * Per-integration queue families are derived from the in-tree
 * integration registry (`@withmarfa/shared` → `IN_TREE_INTEGRATIONS`).
 * Each integration declares its triggers; the registry filters into
 * three families consumed below:
 *
 *   - **Reactive-run**: integrations with an `item-event` trigger get
 *     `marfa-reactive-run-<slug>-<env>` (+ DLQ). The server's
 *     `reactive-run-bridge` routes envelopes per `integration_name` to
 *     the matching producer URL.
 *   - **Webhook-receipt**: integrations with a `webhook` trigger AND a
 *     dedicated `webhookQueueBinding` get
 *     `marfa-webhook-receipt-<slug>-<env>` (+ DLQ). Integrations without
 *     the binding stay on the shared queue (`withmarfa.github-webhooks`
 *     today).
 *   - **Scheduled-poll**: integrations with a `schedule` trigger get
 *     `marfa-scheduled-poll-<slug>-<env>` (+ DLQ). The slug uses
 *     `scheduledPollSlugFor()` to honour per-integration naming
 *     overrides (some drop the publisher prefix, some keep it).
 *
 * Slug for reactive-run + webhook-receipt mirrors the existing
 * `queueSlug()` helper (`integration_name.replace('.','-')`); for
 * scheduled-poll the registry's per-integration override wins.
 */
const REACTIVE_RUN_INTEGRATIONS = integrationsWithTrigger("item-event").filter(
  (i) => i.hasWorker,
);
const WEBHOOK_RECEIVING_INTEGRATIONS = integrationsWithTrigger(
  "webhook",
).filter((i) => i.hasWorker && i.webhookQueueBinding);
const SCHEDULED_POLL_INTEGRATIONS = integrationsWithTrigger("schedule").filter(
  (i) => i.hasWorker,
);

/**
 * Cloudflare Queue names must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`
 * (no dots). The publisher-namespaced manifest name (e.g.
 * `withmarfa.task-auto-archive`, `google.calendar`) carries a dot, so the
 * provisioner lowercases + replaces every dot with a hyphen to derive
 * the queue-name slug — same shape already used by the existing
 * `marfa-scheduled-poll-<slug>-<env>` and
 * `marfa-webhook-receipt-<slug>-<env>` queues.
 *
 *   "withmarfa.task-auto-archive" → "withmarfa-task-auto-archive"
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
    `marfa-webhook-receipt-${env}`,
    `marfa-webhook-receipt-${env}-dlq`,
    `marfa-scheduled-poll-${env}`,
    `marfa-scheduled-poll-${env}-dlq`,
    // The shared `marfa-reactive-run-${env}` (+ DLQ) is kept while any
    // connection still drains through the shared queue. Once all
    // connections have moved to their per-integration queues, this
    // entry can be removed from this list.
    `marfa-reactive-run-${env}`,
    `marfa-reactive-run-${env}-dlq`,
  ];
  // Per-integration reactive-run queues. Each integration with an
  // `item-event` trigger gets its own queue + DLQ; the server's bridge
  // routes envelopes per `integration_name` to the matching queue URL.
  // The integration name's publisher dot is replaced with a hyphen for
  // the queue slug because Cloudflare Queues reject dot characters.
  for (const integration of REACTIVE_RUN_INTEGRATIONS) {
    const slug = queueSlug(integration.name);
    wanted.push(`marfa-reactive-run-${slug}-${env}`);
    wanted.push(`marfa-reactive-run-${slug}-${env}-dlq`);
  }
  // Per-integration webhook-receipt queues. Each integration with a
  // `webhook` trigger AND a dedicated binding gets its own queue + DLQ;
  // the control plane's webhook route resolves a per-integration producer
  // binding and writes verified deliveries there. Integrations without a
  // binding (e.g. github-webhooks today) stay on the shared queue.
  for (const integration of WEBHOOK_RECEIVING_INTEGRATIONS) {
    const slug = queueSlug(integration.name);
    wanted.push(`marfa-webhook-receipt-${slug}-${env}`);
    wanted.push(`marfa-webhook-receipt-${slug}-${env}-dlq`);
  }
  // Per-integration scheduled-poll queues. Each integration with a
  // `schedule` trigger gets its own queue + DLQ; the integration's
  // Worker consumes from it on each cron tick. The slug uses the
  // registry's per-integration `scheduledPollQueueSlug` override because
  // some consumer wrangler.toml entries dropped the publisher prefix.
  for (const integration of SCHEDULED_POLL_INTEGRATIONS) {
    const slug = scheduledPollSlugFor(integration);
    wanted.push(`marfa-scheduled-poll-${slug}-${env}`);
    wanted.push(`marfa-scheduled-poll-${slug}-${env}-dlq`);
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
    `marfa-webhook-receipt-${env}-dlq`,
    `marfa-scheduled-poll-${env}-dlq`,
    `marfa-reactive-run-${env}-dlq`,
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
  const wanted = [`marfa-control-idempotency-${env}`];
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
  const wanted = [`marfa-runtime-payloads-${env}`];
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
      "[tunnel]   the CNAME manually (runtime[-staging].marfa.so → tunnel uuid).",
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

  // Pre-built CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS map for the server's
  // env. The server reads this at boot to route reactive item-event
  // envelopes per `integration_name` (see
  // packages/server/src/connections/reactive-run-bridge.ts). Paste the
  // value below into the staging/prod env. One URL per integration; new
  // integrations need an entry in REACTIVE_RUN_INTEGRATIONS at the top
  // of this script + a re-run.
  const reactiveRunUrls: Record<string, string> = {};
  for (const integration of REACTIVE_RUN_INTEGRATIONS) {
    const queueName = `marfa-reactive-run-${queueSlug(integration.name)}-${env}`;
    const queueId = out.queues[queueName];
    if (!queueId) {
      console.warn(
        `[reactive-urls] ! ${integration.name}: queue ${queueName} not provisioned; skipping URL entry`,
      );
      continue;
    }
    // Map key is the full integration_name (with dot) — that's what
    // the server's bridge resolver looks up against the envelope's
    // `integration_name` field. The queue name drops the dot to satisfy
    // Cloudflare's naming rules; the URL embeds the queue ID, not the name.
    reactiveRunUrls[integration.name] =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`;
  }
  console.log("");
  console.log("CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS (paste into server env):");
  console.log(JSON.stringify(reactiveRunUrls));
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
