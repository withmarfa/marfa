# withmarfa-inbox

Email-to-Marfa capture. Receives emails sent to a Marfa-managed address
(`capture@inbox.marfa.so` in single-space v1) via Cloudflare Email
Routing → Email Worker → signed JSON webhook → Marfa handler. Each
delivery lands as a `withmarfa.captured_email` item.

This integration is **substrate-shaped**, not OAuth- or token-shaped:
there is no upstream API to talk to. Cloudflare Email Routing IS the
substrate, and the "credential" is the HMAC-SHA256 shared secret the
Email Worker holds and the Marfa server stores on the connection's
`inbound_webhooks` subscription.

## Pipeline

```
sender@example.com
      │ (SMTP)
      ▼
inbox.marfa.so (MX → Cloudflare)
      │
      ▼
Cloudflare Email Routing
      │  match: capture@inbox.marfa.so
      ▼
marfa-inbox-email-worker (CF Email Worker)
      │  postal-mime → JSON envelope
      │  HMAC-SHA256 over body with WEBHOOK_SECRET
      ▼
POST <MARFA_API_URL>/runtime/webhook/<CONNECTION_ID>
      │  X-Marfa-Signature: sha256=<hex>
      │  X-Marfa-Delivery-Id: <Message-ID>
      │  (real HTTPS to the Marfa server)
      ▼
server webhook receipt (cloudflare-email verifier →
      │  idempotency check → local-substrate queue)
      ▼
withmarfa.inbox integration handler
      │  decode → buildCapturedEmail → ctx.marfa.createItem
      ▼
withmarfa.captured_email item (source_id = Message-ID)
```

The Worker exists because Email Routing can only deliver inbound mail
to a Worker or forward it to a mailbox — it cannot POST to a server.
It is the one Cloudflare Worker the platform keeps.

## One integration, one adjacent Email Worker

This directory is one logical integration plus one deployable Worker:

- **`./src/`** — the integration package: manifest, handlers, and the
  `dist/local.js` entry the server's integration runtime loads.
- **`./email-worker/`** — the Cloudflare Email Worker that converts
  inbound email → signed JSON webhook. Its own wrangler.toml, deploy
  command, and npm workspace package. Dispatches over real HTTPS to the
  Marfa server's webhook receipt route,
  `<MARFA_API_URL>/runtime/webhook/<CONNECTION_ID>`, and holds no
  binding to anything: its three secrets (`MARFA_API_URL`,
  `CONNECTION_ID`, `WEBHOOK_SECRET`) are the whole of its coupling.

## Space routing (v1)

v1 uses a **single capture address**: `capture@inbox.marfa.so`. Since
the staging instance is single-space, that suffices.

Future multi-space: address-suffix encoding (e.g.
`capture-<space_slug>@inbox.marfa.so`). The Email Worker would parse
`message.to` and look up the connection by suffix → match against
the install-time-stored slug. Filed for a follow-on once a second
space ships.

## Verification — `cloudflare-email` adapter

The new `cloudflare-email` verifier in `@withmarfa/webhooks` is
mechanically identical to `hmac-sha256` (same HMAC algorithm, same
`X-Marfa-Signature` + `X-Marfa-Delivery-Id` headers). The distinct
manifest method declares the body schema the handler decodes against
— a contract layer above the verification primitive.

## Idempotency

Two walls of defense:

1. **Server-side `connection.runtime.idempotency`** — keyed on the
   `external_delivery_id` surfaced by the verifier (= the
   `X-Marfa-Delivery-Id` header = the email's Message-ID). A
   re-delivered email (CF retry, manual replay, second forward)
   short-circuits at the server's webhook receipt route before
   reaching the handler.
2. **Handler-side bounded ring** — `DELIVERY_RING_SIZE` (1024) most-
   recent Message-IDs on the cursor's `delivery_ring`. Mirrors the
   github-webhooks pattern. Belt-and-braces.

When a Message-ID is absent (rare — synthesized messages, bare
forwarder errors), the handler falls back to the header-level
delivery id. `source_id` is then omitted, so the (source, source_id)
natural-key upsert path doesn't apply and a duplicate would write a
fresh item; the ring still dedupes within the handler's window.

## Attachments — metadata only (v1)

The type schema's `attachments` field captures `{ filename,
mime_type, size_bytes }` only. Actual blob upload requires the runtime
SDK's `uploadBlob` primitive, which is not yet wired. `blob_ref` can
be added once that primitive ships.

## DNS + Email Routing — operator setup

The DNS for `inbox.marfa.so` is operator-controlled. To bring the
integration up end-to-end:

1. **MX records on `inbox.marfa.so`** — point at Cloudflare's email
   routing destinations. Cloudflare's dashboard ("Email → Email
   Routing → Enable Email Routing") auto-writes these. Verify the
   three MX entries land and the SPF TXT record (`v=spf1
include:_spf.mx.cloudflare.net ~all`) is present on the
   subdomain.
2. **Email Routing rule.** Inside the `marfa.so` zone, create a
   custom-address rule: `capture@inbox.marfa.so` → "Send to Worker:
   `marfa-inbox-email-worker-staging`".
3. **Deploy the Email Worker.** Use the deploy wrapper:
   `scripts/deploy-worker.sh integrations/withmarfa-inbox/email-worker --env staging`
   after setting three secrets via `wrangler secret put --env staging`:
   `MARFA_API_URL` (the deployment's public API origin),
   `CONNECTION_ID` (the `system.connection` id this Worker dispatches
   against) and `WEBHOOK_SECRET` (matches the subscription's
   `secret_encrypted` on the Marfa server). Nothing else needs to be
   deployed first.

The Worker holds NO durable state — re-deploying overwrites the
existing Worker, and Email Routing rules persist independently.

## Local validation

Local validation does NOT require real DNS — the harness POSTs a
signed payload directly to the staging server's
`/runtime/webhook/:connection_id` endpoint, which is now literally
what the Email Worker does in production. The real end-to-end test
(real DNS, real CF Email Routing, real email send from a real sender
mailbox) is done as a final validation stage.
