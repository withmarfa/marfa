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
wrangler secret put CLOUDFLARE_QUEUES_API_TOKEN --env <env>
```

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
