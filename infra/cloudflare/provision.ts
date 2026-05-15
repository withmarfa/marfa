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
    `myme-reactive-run-${env}`,
    `myme-reactive-run-${env}-dlq`,
  ];
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
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
