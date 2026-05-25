# integrations/

Per-Integration packages that implement the manifest contract from
`@withmarfa/shared/integration-manifest.ts`. Each subdirectory is a
self-contained npm workspace; the runtime substrate loads them
through the patterns below.

## Manifest contract

Every integration ships `src/manifest.ts` exporting an
`IntegrationManifest`. Sibling `src/manifest.test.ts` parses through
`IntegrationManifestSchema` so manifest drift is caught at build time
rather than at the first install attempt. The schema lives in
`packages/shared/src/integration-manifest.ts`; valid fields are
documented there in narrative comments.

The `name` follows publisher-namespaced grammar (`<publisher>.<type>`).
Per-service publisher families (`google.calendar`, `google.tasks`)
share their first segment so subsequent integrations under the same
upstream can reuse one OAuth credential (PR1 of T-231 wires this).

## Handler shape

Three handler types, all imported from `@withmarfa/runtime-sdk`:

- `registerScheduleHandler(handler)` — invoked on the manifest's cron.
- `registerItemEventHandler(handler)` — invoked reactively on Marfa
  item events of the manifest's `target_types`.
- `registerWebhookHandler(handler)` — invoked when an inbound webhook
  arrives on the connection's subscription URL after the verification
  adapter passes.

All handlers receive a `ConnectionContext` first arg with:

- `ctx.marfa` — the connection-scoped client (stamps cycle metadata).
- `ctx.cursor` — per-Connection state store (the
  `connection.runtime` reserved extension namespace under the hood).
- `ctx.activity` — typed emitter for `system.activity` rows. Severity
  `info` for steady-state operations, `action_required` for things
  the operator must resolve, `error` for unrecoverable failures.
- `ctx.echo` — echo-suppression and lag-window helpers. Outbound
  writes go through `ctx.echo.trackOutboundWrite(external_id, hash)`;
  inbound reads check `ctx.echo.shouldSkipReactive(...)` before
  upserting to avoid echo loops.
- `ctx.cycle` — cycle-detection metadata for the request chain
  (`originating_connection_id`, `hop_count`). The reactive bridge
  filters self-events upstream but defensive double-checking is
  expected.

Handler results are `{ ok: true }` for success, `{ ok: false, retry:
boolean, reason: string }` for failure. `retry: true` reschedules via
queue retry; `retry: false` acks but emits an `action_required`
activity row.

## Bidirectional handling

The manifest's `bidirectional_handling` block declares four primitives
that the substrate enforces, not the handler:

- `echo_ttl_seconds` — how long an outbound write is considered an
  "own write" for echo suppression.
- `lag_window_seconds` — how long after an outbound write to defer
  inbound reads of the same external id (stomp-race guard).
- `tombstone_mapping` — `state-trashed` (cascading external delete →
  Marfa trash), `prompt-user` (action_required activity), or `ignore`.
- `partial_write_mode` — `all-or-nothing` rolls back local optimism
  on any per-item failure; `accept-partial` commits what succeeded.

Handler code reads from `ctx.echo` (TTL + lag window) and from the
config; it doesn't re-implement these primitives.

## OAuth-backed integrations

Manifest declares `oauth_requirements: { <capability>: "proxy" | "leased" }`.
Tokens are bootstrapped via the server's provider-agnostic
`GET /oauth/callback/:provider` route — the integration handler never
sees them directly. To call the upstream, use `ctx.marfa.proxyRequest(method,
path, body)` against the connection's proxy URL; the server stamps
the bearer transparently and refreshes on 401.

To install an OAuth-backed integration:

1. Admin creates a `system.credential` of `kind: oauth_token` carrying
   the OAuth client config (authorize URL, token URL, client_id,
   encrypted client_secret) via `POST /credentials/oauth-provider`.
2. Install passes the credential id via `credential_ref` on
   `POST /connections/install` — multiple integrations of the same
   upstream share the credential row instead of duplicating.
3. After install, the consent UI directs the user to
   `/connections/:id/oauth/start` which builds the authorize URL.
4. Google's redirect lands on `/oauth/callback/google` (or whichever
   provider name), exchanges the code, persists tokens encrypted
   under `SECRET_INFO.connectionOauthToken`.

## Token-backed integrations (T-241)

Manifests whose upstream uses a static API token rather than an OAuth
flow declare `token_requirements: { <capability>: "required" }` and
bump their `manifest_schema_version` to `1.1.0`. Today's instances are
Todoist, Readwise, Raindrop — every API-key-based upstream lands here.

The substrate seam mirrors the OAuth one: the bearer lives on a
`system.credential` row, referenced from the connection via
`credential_ref`. The two kinds share the same encryption domain
(`connectionOauthToken`), the same install path
(`POST /connections/install`), and the same proxy entry point
(`POST /connections/:id/proxy/*`). The differences:

- **Kind on the credential** — `kind: "api_token"` instead of
  `kind: "oauth_token"`. The non-secret config lives under
  `api_token_config: { upstream_base_url }` (parallel to
  `oauth_provider_config`); the bearer lives under `secret_encrypted`.
- **Install path** — `POST /credentials/api-token` (body
  `{ label, upstream_base_url, api_token }`) instead of
  `/credentials/oauth-provider`. Same `requireTenantAdmin` gate.
  Returns `{ credential_id }` for use as `credential_ref` on
  `POST /connections/install`.
- **No OAuth dance** — there is no authorize URL, no callback. The
  user supplies the bearer at install time directly; the connection
  is immediately usable.
- **Bearer stamped verbatim** — `ctx.marfa.proxyRequest(...)` reads the
  credential, decrypts the bearer, sets `Authorization: Bearer <token>`
  on every upstream call. No proactive refresh, no reactive refresh.
- **401 → `action_required`** — when the upstream rejects the bearer,
  the proxy flips `runtime_status` to `reauth_required` and emits a
  `system.activity` of `severity: action_required` reading "Static API
  token rejected — reinstall connection with a fresh token". Static
  tokens have no refresh primitive; the operator recovery path is
  to mint a fresh credential via `POST /credentials/api-token` and
  reinstall the connection.

To install a token-backed integration end-to-end:

1. Admin calls `POST /credentials/api-token` with the upstream base
   URL and the user-supplied bearer → `{ credential_id }`.
2. Admin calls `POST /connections/install` with
   `{ integration_id, credential_ref: credential_id }` →
   `{ connection_id }`. The connection is immediately active; no
   further consent step.
3. Subsequent scheduled / reactive runs of the integration call
   `ctx.marfa.proxyRequest(...)`; the server stamps the bearer
   transparently.

## Worker-to-Worker calls use Service Bindings, not HTTP fetch (T-250)

When a Cloudflare Worker in this monorepo calls another Cloudflare
Worker in the same account, declare a Service Binding in the caller's
`wrangler.toml` and dispatch via `env.<BINDING>.fetch(request)` —
never `fetch(<workers.dev URL>, ...)` or `fetch(<custom-domain>, ...)`.
Service Bindings dispatch directly to the bound Worker's `fetch`
handler with no DNS, TLS, or edge hop, so they:

- sidestep custom-domain availability incidents (the 522 that
  surfaced in T-244 was the trigger for T-250)
- avoid leaking deployment topology through `<service>.<account>.workers.dev`
  URLs
- type-check the binding target at deploy time (`binding target not
found` is a hard failure, not a silent 404)

The synthetic host in the constructed `Request` URL is ignored by
the binding — only path, headers, and body reach the bound Worker.
Convention: use `https://<binding-name-lowercase>` as the placeholder
host so tests / logs make the binding shape obvious.

The withmarfa-inbox Email Worker is the canonical example —
`integrations/withmarfa-inbox/email-worker/wrangler.toml` declares
`RUNTIME_CONTROL → marfa-runtime-control-<env>`, and
`src/index.ts` dispatches via
`env.RUNTIME_CONTROL.fetch(...)` against
`/webhooks/inbound/<CONNECTION_ID>`.

## First-deploy operator setup (hosted substrate, T-255)

Every per-Integration Worker needs three secrets set before the first
queue dispatch will succeed:

- `MARFA_API_URL` — the deployed Marfa API URL the in-Worker
  `ConnectionClient` calls back into.
- `MARFA_RUNTIME_CONTROL_URL` — the runtime-control Worker's URL,
  where the consumer mints per-Connection runtime credentials via
  the `/lease/:connection_id/runtime` broker.
- `MARFA_RUNTIME_BROKER_KEY` — the platform broker key the consumer
  presents to that lease endpoint. Same value as the server's
  `MARFA_RUNTIME_BROKER_KEY` env.

Without these the queue consumer's `mintCredential()` throws on the
first dispatch with a URL like `undefined/lease/<id>/runtime`. T-255
added a `console.error` line surfacing the failure via `wrangler tail`
(grep for `[runtime-sdk:consumeBatch] dispatch threw`), but messages
silently retry + go to DLQ; no items land, no `system.activity`
appears (the activity-emit path needs a working `ConnectionClient`
that needs the broker secrets — circular dependency in the degraded
mode). Failing-loud beats failing-silent: set the secrets first.

A helper at `infra/cloudflare/scripts/init-integration-worker-secrets.sh`
reads the three values from the calling shell's environment and runs
`wrangler secret put` for each:

```bash
# Source your per-machine secrets file first so the three env vars
# (MARFA_API_URL, MARFA_RUNTIME_CONTROL_URL, MARFA_RUNTIME_BROKER_KEY)
# + CLOUDFLARE_API_TOKEN are exported.
./infra/cloudflare/scripts/init-integration-worker-secrets.sh \
  integrations/google-contacts staging
```

Re-run the helper any time the broker key rotates. Each integration's
`wrangler.toml` carries a comment block listing the same three
secrets as a reminder.

## Substrate parity

`@withmarfa/server`'s `MARFA_INTEGRATION_RUNTIME` env var picks the
substrate at deployment time: `hosted` (Cloudflare Workers + Queues

- Durable Objects) or `local` (in-process Node + pg-boss +
  worker_threads). The handler-authoring surface is identical — the
  same `dist/local.js` registers handlers on both. The integration's
  manifest declares which tiers it supports via `runtime_compatibility:
["hosted", "local"]`. Build invariants:

* `tsup.config.ts` emits `dist/local.js` for the local substrate.
* The hosted substrate consumes `src/worker.ts` directly via
  `wrangler` at deploy time.
* `@withmarfa/runtime-sdk` and `@withmarfa/shared` MUST stay external in
  every bundle that loads integrations alongside them — the handler
  `REGISTRY` and shared registries are module-singleton state.
* The smoke at `pnpm --filter @withmarfa/server run smoke:worker-entry`
  guards both invariants at build time.

## In-tree integrations

- `_template` — scaffold to copy when starting a new integration.
- `rss-watcher` — scheduled poll of a feed → `core.bookmark`.
- `github-webhooks` — inbound webhook on a repo → `core.bookmark`.
- `google-calendar` — bidirectional OAuth sync with the
  `google.calendar` family (this is the upstream-fidelity sibling
  to forthcoming `google.tasks`, `google.contacts`, etc.).
- `task-auto-archive` — item-event automation on `core.task` items.
- `sync` — re-presents the external sync daemon as a Connection
  (local-only).

Per-integration `CLAUDE.md` files (where present) carry the
upstream-specific gotchas — scope choices, dedup quirks,
recurrence handling, channel renewal patterns.
