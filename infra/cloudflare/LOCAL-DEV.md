# Local-dev loop for the Connections runtime

This walkthrough gets you from a stock checkout to delivering an inbound webhook against a locally running control plane Worker, with the Marfa server running on `:8602`.

## One-time setup

1. Install [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Cloudflare Tunnel CLI).
2. Set your Cloudflare credentials in your shell:
   ```sh
   export CLOUDFLARE_API_TOKEN=<token with Workers/Queues/KV/R2 scope>
   export CLOUDFLARE_ACCOUNT_ID=<account id>
   ```
3. Authenticate cloudflared once: `cloudflared tunnel login`.

## Daily flow

In **terminal A** (Marfa server):

```sh
cd /path/to/marfa
pnpm --filter @withmarfa/server run dev      # boots on :8602 by default
```

In **terminal B** (control-plane Worker):

```sh
cd /path/to/marfa
pnpm --filter @withmarfa/runtime-control dev  # wrangler dev on :8787
```

In **terminal C** (cloudflared tunnel):

```sh
cloudflared tunnel --url http://localhost:8787
# Outputs a https://<random>.trycloudflare.com URL
```

The control plane is now reachable from anywhere on the internet at the printed URL. Use that URL when configuring the upstream service that will deliver inbound webhooks to your Connection.

## Sending a test webhook

A. Use `curl` to POST a fake delivery (computes the HMAC against your Connection's secret):

```sh
SECRET="<the secret you stored on the connection>"
BODY='{"event":"test"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)
curl -X POST "https://<your-tunnel>.trycloudflare.com/webhooks/inbound/<connection_id>" \
  -H "X-Marfa-Signature: sha256=$SIG" \
  -H "X-Marfa-Delivery-Id: dev-001" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

A successful delivery returns 202 and enqueues onto `WEBHOOK_RECEIPT_QUEUE`. With no per-Integration Worker subscribed yet (Layer 3), the message sits in the queue until consumed or expires. Use `wrangler queues consumer` to peek.

## Named-tunnel (stable hostname)

Once you tire of the `*.trycloudflare.com` URL changing on every restart, set up a named tunnel — see [tunnel.config.example.yml](tunnel.config.example.yml) for the YAML shape. The config goes at `~/.cloudflared/<name>.yml` and `cloudflared tunnel run <name>` brings it up against the same host:port. Layer 1 acceptance verification doesn't require the named-tunnel path.

## Troubleshooting

- **403 from `/system/runtime-credentials`:** the Marfa caller credential needs `is_platform: true`. The bootstrap admin key has it; an arbitrary admin key minted later does NOT unless you pass `is_platform: true` at create time.
- **503 `control_plane_misconfigured` from `/webhooks/inbound`:** set `MARFA_API_URL` and `MARFA_RUNTIME_BROKER_KEY` in `wrangler dev`'s env (either via `.dev.vars` or the wrangler CLI). The broker key is whatever long-lived `is_platform: true` admin key the control plane should authenticate as.
- **404 `no_subscriptions`:** you haven't created an `inbound_webhook` row for the `connection_id`. Use the existing `POST /connections/:id/inbound-webhooks` route (workstream 2 PR 5).
