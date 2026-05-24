# mymehq-inbox

Email-to-Myme capture. Receives emails sent to a Myme-managed address
(`capture@inbox.myme.so` in single-tenant v1) via Cloudflare Email
Routing → Email Worker → signed JSON webhook → Myme handler. Each
delivery lands as a `mymehq.captured_email` item.

This integration is **substrate-shaped**, not OAuth- or token-shaped:
there is no upstream API to talk to. Cloudflare Email Routing IS the
substrate, and the "credential" is the HMAC-SHA256 shared secret the
Email Worker holds and the Myme server stores on the connection's
`inbound_webhooks` subscription.

## Pipeline

```
august@cayzer.me
      │ (SMTP)
      ▼
inbox.myme.so (MX → Cloudflare)
      │
      ▼
Cloudflare Email Routing
      │  match: capture@inbox.myme.so
      ▼
mymehq-inbox-email-worker (CF Email Worker)
      │  postal-mime → JSON envelope
      │  HMAC-SHA256 over body with WEBHOOK_SECRET
      ▼
POST https://staging.myme.so/runtime/webhook/<connection_id>
      │  X-Myme-Signature: sha256=<hex>
      │  X-Myme-Delivery-Id: <Message-ID>
      ▼
Myme server (cloudflare-email verifier → enqueue WebhookMessage)
      │
      ▼
mymehq.inbox integration handler
      │  decode → buildCapturedEmail → ctx.myme.createItem
      ▼
mymehq.captured_email item (source_id = Message-ID)
```

## Two Workers, one integration

This directory is one logical integration with two deployable Workers:

- **`./src/`** — the standard per-Integration Worker (consumes
  `myme-webhook-receipt-mymehq-inbox-<env>` — its own dedicated
  queue per T-247; CF Queues allow only one consumer per queue, so
  every inbound-webhook integration gets its own). Bound under
  `INTEGRATION_MYMEHQ_INBOX` in `wrangler.control.toml`. The control
  plane's webhook receipt route resolves the producer binding
  (`WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX`) by `integration_name`.
- **`./email-worker/`** — the Cloudflare Email Worker that converts
  inbound email → signed JSON webhook. Distinct Cloudflare product
  (Email Worker), distinct wrangler.toml, distinct deploy command,
  distinct npm workspace package. Not bound under the control plane —
  it talks directly to the staging server's `/runtime/webhook/` route.

The two are independent deployables — bring them up in either order;
the system tolerates one being absent (the Email Worker would have
no recipient; the integration Worker would have no senders).

## Tenant routing (v1)

v1 uses a **single capture address**: `capture@inbox.myme.so`. Since
the staging instance is single-tenant, that suffices.

Future multi-tenant: address-suffix encoding (e.g.
`capture-<tenant_slug>@inbox.myme.so`). The Email Worker would parse
`message.to` and look up the connection by suffix → match against
the install-time-stored slug. Filed for a follow-on once a second
tenant ships.

## Verification — `cloudflare-email` adapter

The new `cloudflare-email` verifier in `@mymehq/webhooks` is
mechanically identical to `hmac-sha256` (same HMAC algorithm, same
`X-Myme-Signature` + `X-Myme-Delivery-Id` headers). The distinct
manifest method declares the body schema the handler decodes against
— a contract layer above the verification primitive.

## Idempotency

Two walls of defence:

1. **Server-side `connection.runtime.idempotency`** — keyed on the
   `external_delivery_id` surfaced by the verifier (= the
   `X-Myme-Delivery-Id` header = the email's Message-ID). A
   re-delivered email (CF retry, manual replay, second forward)
   short-circuits at the server's webhook receipt route before
   reaching the handler.
2. **Handler-side bounded ring** — `DELIVERY_RING_SIZE` (1024) most-
   recent Message-IDs on the cursor's `delivery_ring`. Mirrors the
   github-webhooks pattern. Belt-and-braces.

When a Message-ID is absent (rare — synthesised messages, bare
forwarder errors), the handler falls back to the header-level
delivery id. `source_id` is then omitted, so the (source, source_id)
natural-key upsert path doesn't apply and a duplicate would write a
fresh item; the ring still dedupes within the handler's window.

## Attachments — metadata only (v1)

The type schema's `attachments` field captures `{ filename,
mime_type, size_bytes }` only. Actual blob upload requires the
runtime SDK to ship an `uploadBlob` primitive (gated on
[[T-239-runtime-sdk-upload-blob-primitive]]). Documented gap until
that lands; a follow-on ticket wires `blob_ref` once the primitive
exists.

## DNS + Email Routing — operator setup

The DNS for `inbox.myme.so` is operator-controlled. To bring the
integration up end-to-end:

1. **MX records on `inbox.myme.so`** — point at Cloudflare's email
   routing destinations. Cloudflare's dashboard ("Email → Email
   Routing → Enable Email Routing") auto-writes these. Verify the
   three MX entries land and the SPF TXT record (`v=spf1
include:_spf.mx.cloudflare.net ~all`) is present on the
   subdomain.
2. **Email Routing rule.** Inside the `myme.so` zone, create a
   custom-address rule: `capture@inbox.myme.so` → "Send to Worker:
   `myme-mymehq-inbox-email-worker-staging`".
3. **Deploy the Email Worker.** `wrangler deploy --env staging`
   from `./email-worker/` after setting `WEBHOOK_URL` and
   `WEBHOOK_SECRET` via `wrangler secret put --env staging`.

The Worker holds NO durable state — re-deploying overwrites the
existing Worker, and Email Routing rules persist independently.

## Local validation

Local validation does NOT require real DNS — the harness simulates
the inbound by POSTing a signed payload directly to the staging
server's `/runtime/webhook/:connection_id` endpoint, mimicking what
the Email Worker would emit. The real end-to-end test (real DNS,
real CF Email Routing, real email send from `august@cayzer.me`) is
done as the final stage of the T-244 validation log.
