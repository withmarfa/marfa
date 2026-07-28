# @withmarfa/runtime-control

The Cloudflare Worker control plane for the hosted integrations substrate. Routes inbound webhooks to the right per-Integration Worker, brokers per-Connection leased credentials, handles install callbacks, and exposes the DLQ peek / replay surface. Private package — deployed via `wrangler`, never published to npm.

## Layout

- `src/index.ts` — Worker entry. Composes the Hono app via `buildApp()` and runs a one-shot config check on first fetch (warns when `CLOUDFLARE_QUEUES_API_TOKEN` is unset — the DLQ routes return 503 without it).
- `src/app.ts` — Hono app builder; mounts each route group.
- `src/env.ts` — `ControlPlaneEnv` type and helpers for the Worker's bindings (Queues, KV, secrets).
- `src/marfa-client.ts` — minimal HTTP client for calling back into Marfa (`POST /system/runtime-credentials`, etc.) using the runtime broker key.
- `src/cf-queues-pull.ts` — Cloudflare Queues pull/ack helper for the DLQ surfaces; gated on `CLOUDFLARE_QUEUES_API_TOKEN`.
- `src/routes/`:
  - `webhooks.ts` — `POST /webhooks/inbound/:connection_id`: verifies the signature via `@withmarfa/webhooks`, looks up the subscription, **routes to the per-integration webhook-receipt producer** (`WEBHOOK_RECEIPT_QUEUE_<INTEGRATION>` bindings keyed by `integration_name`, with the shared `WEBHOOK_RECEIPT_QUEUE` as fallback for `withmarfa.github-webhooks`). Returns 202 on accept; the response body's `routed_via` field surfaces whether the dispatch hit a dedicated or shared producer.
  - `lease.ts` — `POST /lease/:connection_id/runtime`: mints (or refreshes) the per-Connection runtime credential via the broker. A terminal verdict carries its own code and status (`connection_not_found` 404, `connection_not_active` 403) so the Worker can tell "gone for good" from "retry later"; everything else is `mint_failed` 502. A refusal is classified by the server's error **code**, with the status only as a cross-check: both statuses are shared with failures that are not about any connection (a non-platform broker key also answers 403, an unmatched route also answers 404), and reading either as terminal would deschedule the whole fleet on one misconfiguration. `POST /lease/:connection_id/oauth/:capability_id`: not yet implemented (501). Both routes require the broker key.
  - `verify.ts` — `POST /connections/:connection_id/verify`: synchronously dispatches a test event through the connection's integration handler and polls activity; gated on a platform operator bearer forwarded to the server's verify-context endpoint.
  - `arm-schedule.ts` — `POST /connections/:connection_id/arm-schedule` and `POST /connections/:connection_id/disarm-schedule`: dispatch to the connection's per-Integration Worker over its service binding so the per-Connection Durable Object sets or cancels its schedule alarm. Both require the broker key. Disarm is idempotent, and an integration that ships no Worker reports `dispatched: false` without dispatching. A dispatch failure carries `error: "dispatch_failed"` alongside the Worker's own response on `result`.
  - `dlq.ts` — `POST /dlq/peek` and `POST /dlq/replay`: gated on a platform operator bearer (forwarded to the server's dlq-context endpoint) and on `CLOUDFLARE_QUEUES_API_TOKEN`.
  - `health.ts` — `GET /health`.

## Authoring rules

- **Web Crypto only.** This package runs in a Workers isolate. No Node APIs, no `Buffer` — anything cryptographic goes through `crypto.subtle` (and through `@withmarfa/webhooks` for inbound verification).
- **Inbound verification goes through `@withmarfa/webhooks`.** Don't add a sibling verifier here. Pick the adapter by `VerificationMethod` and pass the raw body + signature + secret through.
- **Failures are JSON.** Errors return `{ error: <code>, message?: ... }` with an HTTP status; never throw past the route boundary.

## Build

No bundle step. `wrangler dev` / `wrangler deploy` (driven by `infra/cloudflare/wrangler.control.toml`) consume `src/` directly through `wrangler`'s built-in TypeScript pipeline.

## Testing

`pnpm test` runs the Vitest suite under the Node runtime — every test uses Hono's `app.request(...)` rather than booting Miniflare, which keeps the tests fast and avoids the Workers-runtime dependency. Coverage spans: per-route auth gates, signature verification round-trips (`webhook-flow.test.ts`), Queues-pull behavior (`cf-queues-pull.test.ts`), and the one-shot config-check (`index.test.ts`).
