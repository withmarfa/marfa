# Cloudflare provisioning + deployment

Scripts and templates for the Connections runtime substrate. The runtime stack is Cloudflare Workers (per-Integration + a control plane), Durable Objects (per-Connection state), Queues (webhook receipt / scheduled poll / reactive run), R2 (large-payload handoff), and a cloudflared tunnel (local-dev inbound reach).

## Layout

- `wrangler.control.toml` — control-plane Worker config (`@mymehq/runtime-control`). One Worker per env: `dev` (default), `staging`, `prod`.
- `wrangler.integration.template.toml` — copy this into each `integrations/<name>/` once Layer 3 starts. Defaults to per-env (`dev`/`staging`/`prod`) Worker names that follow `myme-integration-<name>[-env]`.
- `provision.ts` — idempotent script that creates Queues, KV namespaces, R2 buckets via the Cloudflare REST API. Run once per env; safe to re-run.
- `tunnel.config.example.yml` — local-dev tunnel template. Copy to `tunnel.config.yml` (gitignored), fill in tunnel UUID + handle.
- `cloudflare-api.ts` — thin REST client used by `provision.ts`. No third-party deps.

## Prereqs

```sh
export CLOUDFLARE_API_TOKEN=<token with Workers/Queues/KV/R2 write>
export CLOUDFLARE_ACCOUNT_ID=<account id>
# Optional, for named-tunnel DNS automation:
export CLOUDFLARE_ZONE_ID=<zone id for myme.so>
```

The current account-scoped token does not carry zone-edit. Named-tunnel DNS routing (CNAME → tunnel UUID) is left as a manual step OR requires a token-scope extension; `provision.ts` fails gracefully on the DNS step with clear instructions.

## Provision an environment

```sh
pnpm --filter @mymehq/infra-cloudflare provision dev
pnpm --filter @mymehq/infra-cloudflare provision staging
pnpm --filter @mymehq/infra-cloudflare provision prod
```

Each run creates (idempotent — checks existence first):

- 6 Queues per env: `myme-{webhook-receipt,scheduled-poll,reactive-run}-<env>` plus `-dlq` siblings.
- 1 KV namespace per env: `myme-control-idempotency-<env>` for the control plane's short-lived idempotency cache.
- 1 R2 bucket per env: `myme-runtime-payloads-<env>` for inbound webhook bodies > 256KB.

The script prints resource IDs at the end — paste these into the relevant `wrangler.*.toml` bindings (PR 3 wires the Queues + KV bindings; Layer 2 wires R2).

## Local-dev loop

1. `pnpm --filter @mymehq/runtime-control dev` — boots the control plane on `localhost:8787` via `wrangler dev`.
2. In a second terminal, `cloudflared tunnel --url http://localhost:8787` — assigns a `*.trycloudflare.com` URL.
3. Configure the Myme server's per-Connection `inbound_webhook` row to deliver to the tunnel URL.
4. Trigger a webhook from the upstream service; the control plane verifies and (eventually — PR 3) enqueues onto the local-mode queue.

For a stable hostname, use the named-tunnel flow in `tunnel.config.example.yml`.

## Deploy

Once provisioning has run and bindings are in `wrangler.*.toml`:

```sh
# Control plane
pnpm --filter @mymehq/runtime-control deploy --env staging

# A specific integration (Layer 3)
pnpm --filter @mymehq/integration-<name> deploy --env staging
```

Production deploys are gated on the orchestrator. Do not push to prod from a feature branch.
