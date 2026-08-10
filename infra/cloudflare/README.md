# Cloudflare provisioning + deployment

Scripts and templates for the Connections runtime substrate. The runtime stack is Cloudflare Workers (per-Integration + a control plane), Durable Objects (per-Connection state), Queues (webhook receipt / scheduled poll / reactive run), R2 (large-payload handoff), and a cloudflared tunnel (local-dev inbound reach).

## Layout

- `wrangler.control.toml` — control-plane Worker config (`@withmarfa/runtime-control`). One Worker per env: `dev` (default), `staging`, `prod`. Carries `REPLACE_WITH_*` placeholders (account-id var, route hostnames, KV namespace ids) and example domains — fill these in for your own account before deploying. `account_id` itself is intentionally absent; Wrangler reads it from `CLOUDFLARE_ACCOUNT_ID` in the environment.
- `wrangler.integration.template.toml` — copy this into each `integrations/<name>/` when adding a new Integration Worker. Defaults to per-env (`dev`/`staging`/`prod`) Worker names that follow `marfa-integration-<name>[-env]`.
- `provision.ts` — idempotent script that creates Queues, KV namespaces, R2 buckets via the Cloudflare REST API. Run once per env; safe to re-run.
- `tunnel.config.example.yml` — local-dev tunnel template. Copy to `tunnel.config.yml` (gitignored), fill in tunnel UUID + handle.
- `cloudflare-api.ts` — thin REST client used by `provision.ts`. No third-party deps.

## Prereqs

```sh
export CLOUDFLARE_API_TOKEN=<token with Workers/Queues/KV/R2 write>
export CLOUDFLARE_ACCOUNT_ID=<account id>
# Optional, for named-tunnel DNS automation:
export CLOUDFLARE_ZONE_ID=<zone id for your domain>
```

If your account-scoped token does not carry zone-edit permission, named-tunnel DNS routing (CNAME → tunnel UUID) is left as a manual step OR requires a token-scope extension; `provision.ts` fails gracefully on the DNS step with clear instructions.

## Provision an environment

```sh
pnpm --filter @withmarfa/infra-cloudflare provision dev
pnpm --filter @withmarfa/infra-cloudflare provision staging
pnpm --filter @withmarfa/infra-cloudflare provision prod
```

Each run creates (idempotent — checks existence first):

- 6 Queues per env: `marfa-{webhook-receipt,scheduled-poll,reactive-run}-<env>` plus `-dlq` siblings.
- 1 HTTP-pull consumer on each of the 3 central DLQs (required by the runtime-control DLQ peek/replay routes — see "DLQ peek operator surface" below).
- 1 KV namespace per env: `marfa-control-idempotency-<env>` for the control plane's short-lived idempotency cache.
- 1 R2 bucket per env: `marfa-runtime-payloads-<env>` for inbound webhook bodies > 256KB.

The script prints resource IDs at the end — paste these into the relevant `wrangler.*.toml` bindings (Queues + KV + R2).

## Required secrets

After provisioning resources, set the per-environment secrets the Workers consume. Secrets are write-only via Wrangler and persist across redeploys; you do not need to re-run these unless rotating.

### Control-plane Worker (`@withmarfa/runtime-control`)

```sh
# Per env: dev | staging | prod. Replace <env> below.
wrangler secret put MARFA_API_URL --env <env>
wrangler secret put MARFA_RUNTIME_BROKER_KEY --env <env>
wrangler secret put MARFA_WORKER_IDENTITY_SECRET --env <env>
wrangler secret put CLOUDFLARE_QUEUES_API_TOKEN --env <env>
```

`MARFA_RUNTIME_BROKER_KEY` is the platform credential the control plane presents to the Marfa server, and that the server presents back on the schedule routes. It stays between those two: it is never sent to an integration Worker and never accepted from one.

`MARFA_WORKER_IDENTITY_SECRET` is the root every integration Worker's key derives from, as `HMAC-SHA256(root, integration_name)`. Only the control plane holds it. Generate a fresh 32-byte value per environment (`openssl rand -hex 32`) — sharing a root across environments would let a staging Worker authenticate against production. Rotating it invalidates every derived key at once, so re-run `scripts/init-integration-worker-secrets.sh` for every integration and redeploy them; do the control plane first, since a Worker presenting a key the control plane has not adopted is refused.

`CLOUDFLARE_QUEUES_API_TOKEN` is an account-scoped CF API token with `queues_read` + `queues_write` scopes — the runtime-control DLQ peek/replay routes use it to call Cloudflare Queues' HTTP-pull API. The same token can be reused across envs (the wrangler-secret bind is per-env).

The control plane logs a structured WARN at fetch-handler boot (cold start) if `CLOUDFLARE_QUEUES_API_TOKEN` is unset; the DLQ peek/replay routes then return 503 `cf_queues_not_configured` until the secret is set. Webhook-receipt and reactive-run routes don't need the secret and continue to work.

## Local-dev loop

1. `pnpm --filter @withmarfa/runtime-control dev` — boots the control plane on `localhost:8787` via `wrangler dev`.
2. In a second terminal, `cloudflared tunnel --url http://localhost:8787` — assigns a `*.trycloudflare.com` URL.
3. Configure the Marfa server's per-Connection `inbound_webhook` row to deliver to the tunnel URL.
4. Trigger a webhook from the upstream service; the control plane verifies and enqueues onto the local-mode queue.

For a stable hostname, use the named-tunnel flow in `tunnel.config.example.yml`.

## Deploy

Once provisioning has run and bindings are in `wrangler.*.toml`:

```sh
# Control plane
pnpm --filter @withmarfa/runtime-control deploy --env staging

# A specific integration
pnpm --filter @withmarfa/integration-<name> deploy --env staging
```

Production deploys are gated on the orchestrator. Do not push to prod from a feature branch.

## Server container deploy

The hosted Marfa server runs as a Cloudflare Containers Worker (Worker front + Container Durable Object), backed by Neon Postgres. Deploying it is **migrate-then-deploy**: pending DB migrations are applied against the env's direct (unpooled) Neon URL first, then the Worker + container roll referencing an immutable per-build image tag (`<env>-<short-sha>`).

### CI dispatch (primary)

The canonical path is the `Deploy server container` workflow (`.github/workflows/deploy-server-container.yml`), triggered manually:

```sh
gh workflow run deploy-server-container.yml -f environment=staging   # default
gh workflow run deploy-server-container.yml -f environment=prod
```

Three jobs run on GitHub-hosted `ubuntu-latest`:

1. `build-push` — builds the `linux/amd64` image **natively** (no QEMU emulation), pushes it to Cloudflare's managed registry under tag `<env>-<short-sha>`.
2. `migrate` — applies pending migrations against the env's direct Neon URL. Gates `deploy`; a failed migration blocks the rollout, so the container never starts against an unmigrated schema.
3. `deploy` — renders `server-container/wrangler.jsonc` and rolls the Worker + container, referencing the same `<env>-<short-sha>` tag the build pushed.

Building natively on a hosted amd64 runner is what makes this reliable: it has no dependency on a local Docker daemon and no slow cross-arch emulation. Required GitHub config (secrets + vars) is listed in the workflow header.

The `deploy` job ends by polling `/health` until it reports the deployed SHA, then printing `roll_window_seconds`. That is the deploy's own measurement of how long the old build kept serving, and a stall fails the job rather than passing quietly, so there is nothing left to check by hand afterwards.

The container is replaced by the first request that finds the running image disagreeing with the tag the Worker was deployed to front, so that first request is what completes the deploy. It still sees the old build; every request after it sees the new one.

### Local build (fallback)

When CI is unavailable, deploy by hand with the scripts under `scripts/`. This requires a working local Docker daemon and is slower on Apple Silicon (the `linux/amd64` image cross-compiles via emulation):

```sh
SHA=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64 -f packages/server/Dockerfile \
  -t "marfa-server:staging-$SHA" --load .
wrangler containers push "marfa-server:staging-$SHA"
./infra/cloudflare/scripts/deploy-server-container.sh staging   # migrates, then deploys
```

The deploy script recomputes the same default `<env>-<short-sha>` tag from the current HEAD, so as long as the working tree is on the commit you built, the tags line up. `migrate-server-db.sh <env>` runs the migrate step standalone; `init-server-container-secrets.sh <env>` sets the Worker's runtime secrets (pooled `DATABASE_URL`, auth secret, ...) — re-run a deploy afterwards so the container restarts and picks them up.

The deploy is env-driven; operator-specific values (account id, Neon URLs, CORS origins, branded host) come from the calling shell's environment. See each script's header for the full variable list.

## DLQ peek operator surface

The runtime-control Worker exposes `/dlq/peek` and `/dlq/replay` for operator inspection of DLQ messages (consumed via `my connections logs --dlq <id>` and `my connections replay-dlq <id>`). Two requirements beyond the routine deploy:

1. **`CLOUDFLARE_QUEUES_API_TOKEN` set on the Worker** — see "Required secrets" above. The Worker logs a WARN at boot when this is missing.
2. **HTTP-pull consumers registered on each central DLQ.** The 3 per-kind DLQs (`marfa-{webhook-receipt,scheduled-poll,reactive-run}-<env>-dlq`) need an `http_pull` consumer for the CF Queues HTTP-pull API to work. `provision.ts` enables this idempotently — re-running provision is the cleanest path. Manual fallback (when re-running provision isn't appropriate):

   ```sh
   for q in marfa-webhook-receipt-<env>-dlq marfa-scheduled-poll-<env>-dlq marfa-reactive-run-<env>-dlq; do
     wrangler queues consumer http add "$q"
   done
   ```

   The CF API returns a misleading 405 `messages cannot be pulled unless http_pull mode is enabled` when the consumer is missing — the actual fix is registering the consumer (the queue's own `type` field stays `null`; consumer registration flips the queue into pull mode at the routing layer).

If `dlq peek` returns errors, check both: (1) `wrangler secret list --env <env>` shows `CLOUDFLARE_QUEUES_API_TOKEN`, (2) `wrangler queues consumer http list <dlq-name>` shows one HTTP pull consumer per central DLQ.
