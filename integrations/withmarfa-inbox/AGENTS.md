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
withmarfa-inbox-email-worker (CF Email Worker)
      │  postal-mime → JSON envelope
      │  HMAC-SHA256 over body with WEBHOOK_SECRET
      ▼
env.RUNTIME_CONTROL.fetch(/webhooks/inbound/<CONNECTION_ID>)
      │  X-Marfa-Signature: sha256=<hex>
      │  X-Marfa-Delivery-Id: <Message-ID>
      │  (Cloudflare Worker Service Binding — no DNS / TLS / edge)
      ▼
runtime-control Worker (cloudflare-email verifier → enqueue
      │  to marfa-webhook-receipt-withmarfa-inbox-<env>)
      ▼
withmarfa.inbox integration handler
      │  decode → buildCapturedEmail → ctx.marfa.createItem
      ▼
withmarfa.captured_email item (source_id = Message-ID)
```

Step 4 reaches the runtime-control Worker through a Service Binding
rather than an HTTP fetch. The binding invokes the bound Worker's
`fetch` handler directly — no DNS, TLS, or edge routing — so there's
no custom-domain or `workers.dev` URL in the path at all.

## Two Workers, one integration

This directory is one logical integration with two deployable Workers:

- **`./src/`** — the standard per-Integration Worker (consumes
  `marfa-webhook-receipt-withmarfa-inbox-<env>` — its own dedicated
  queue; CF Queues allow only one consumer per queue, so every
  inbound-webhook integration gets its own). Bound under
  `INTEGRATION_WITHMARFA_INBOX` in `wrangler.control.toml`. The control
  plane's webhook receipt route resolves the producer binding
  (`WEBHOOK_RECEIPT_QUEUE_WITHMARFA_INBOX`) by `integration_name`.
- **`./email-worker/`** — the Cloudflare Email Worker that converts
  inbound email → signed JSON webhook. Distinct Cloudflare product
  (Email Worker), distinct wrangler.toml, distinct deploy command,
  distinct npm workspace package. Holds a **Service Binding** to the
  runtime-control Worker (`RUNTIME_CONTROL` → `marfa-runtime-control-<env>`)
  and dispatches via `env.RUNTIME_CONTROL.fetch(...)` at path
  `/webhooks/inbound/<CONNECTION_ID>`. The two are deploy-coupled in
  one direction: the Email Worker's deploy fails with
  `binding target not found` if runtime-control hasn't been deployed
  to the same env yet. Bring runtime-control up first.

The two are independent deployables — bring them up in either order;
the system tolerates one being absent (the Email Worker would have
no recipient; the integration Worker would have no senders).

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
   `marfa-withmarfa-inbox-email-worker-staging`".
3. **Deploy the Email Worker.** Use the deploy wrapper:
   `scripts/deploy-worker.sh integrations/withmarfa-inbox/email-worker --env staging`
   after setting `CONNECTION_ID` (the `system.connection` id this
   Worker dispatches against) and `WEBHOOK_SECRET` (matches the
   subscription's `secret_encrypted` on the Marfa server) via
   `wrangler secret put --env staging`. The `RUNTIME_CONTROL` Service
   Binding is declared in `wrangler.toml` and resolves at deploy
   time — runtime-control must be deployed first.

The Worker holds NO durable state — re-deploying overwrites the
existing Worker, and Email Routing rules persist independently.

## Local validation

Local validation does NOT require real DNS — the harness simulates
the inbound by POSTing a signed payload directly to the staging
server's `/runtime/webhook/:connection_id` endpoint, mimicking what
the Email Worker would emit. The real end-to-end test (real DNS, real CF Email Routing, real email
send from a real sender mailbox) is done as a final validation stage.
