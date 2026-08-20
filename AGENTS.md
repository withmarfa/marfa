# Marfa

Typed data layer. This monorepo holds eight active workspace packages, sixteen in-tree Integrations, and the Cloudflare infra package.

**Docs MCP convention.** When working on documented surfaces (types, edges, runtime substrates, connections, auth flows), query the docs MCP at `https://docs.marfa.so/mcp` (or `marfa docs search "<query>"` from the CLI) before re-deriving from source.

**Docs roles.** Published docs live **only** in `withmarfa/docs` — never author docs pages in this repo. In-repo READMEs stay tight (what the repo is, how to build and run it, where canonical docs live); AGENTS.md carries agent and build context. When a change touches a public surface, open a companion `withmarfa/docs` PR as part of the same change and link it from this PR.

**Core packages (`packages/`):**

- **@withmarfa/types** — JSON schemas for the platform-shipped type set, the validator both authoring paths share, plus the generate script that emits the TypeScript registries (`ALL_TYPES`, `ALL_INTEGRATION_TYPES`, `ALL_SYSTEM_TYPES`, `ALL_EDGE_TYPES`). Consumed by `@withmarfa/shared`; private (bundled into shared's dist, not published).
- **@withmarfa/shared** — Wire types, Zod validation schemas, error codes, type-registry consumer, ID utilities, the OAuth scope grammar parser, the `IntegrationManifestSchema`. The foundation every other package imports.
- **@withmarfa/server** — Hono HTTP server exposing the Marfa API (private). Carries the data plane plus the Connections / OAuth / Better Auth surfaces.
- **@withmarfa/sdk** — TypeScript HTTP client. The `@withmarfa/sdk/auth` subpath holds the OAuth helpers (`MarfaAuth`, PKCE helpers, token storages, `startDeviceFlow`); `@withmarfa/sdk/auth/node` holds the Node-only pieces — the shared `~/.marfa/<instance>.json` credential store and its file-backed `TokenStorage` — kept separate so browser bundlers never see `node:fs`.
- **@withmarfa/webhooks** — Cross-runtime inbound-webhook signature verification (HMAC-SHA256, Slack, Stripe, GitHub). Web Crypto only, so `runtime-control` (Workers) and `server` (Node) consume the same code.
- **@withmarfa/runtime-control** — Cloudflare Worker control plane. Verifies inbound webhook receipts, enqueues per-Integration messages, mediates the runtime-credential broker. Web Crypto only; no Node APIs.
- **@withmarfa/runtime-sdk** — In-Worker SDK consumed by Integration Workers. Queue consumer, echo-suppression DO, manifest-typed handler scaffolding.
- **@withmarfa/runtime-test** — In-Worker test harness mirroring the runtime-sdk surface, so Integrations can unit-test in a `miniflare`-style fixture without booting a real Workers runtime.

**In-tree Integrations (`integrations/`):** `_template` (the scaffold every contributor copies), plus fifteen shipping Integrations. Each ships a Zod-canonical `manifest.ts` and a sibling `manifest.test.ts` that parses it through `IntegrationManifestSchema`; the manifest's own `description` is the authoritative summary of what each one does.

- **Bidirectional** — `google-calendar`, `google-contacts`, `google-tasks`, `todoist`, `readwise-reader`.
- **Inbound** — `google-drive`, `google-youtube`, `podcasts`, `raindrop`, `readwise`, `rss-watcher`, `github-webhooks`, `withmarfa-inbox` (email capture via Cloudflare Email Routing).
- **Marfa-side only** — `task-auto-archive` (reacts to item events, no upstream), `sync` (the file-to-Marfa bridge re-presented as a Connection; the agent itself lives in `withmarfa/sync`).

**Infra (`infra/`):** `cloudflare` — `wrangler.jsonc` plus deploy script for the runtime-control Worker, the per-Integration Workers, and the shared Queues / KV / Containers bindings.

`@withmarfa/shared`, `@withmarfa/sdk`, and `@withmarfa/webhooks` publish to npm under the `@withmarfa` scope via OIDC trusted-publisher (`.github/workflows/publish.yml`), fired on `v*` tag pushes. Other workspace packages are private.

## Tech stack

- TypeScript 6 (strict mode, ESM-only, NodeNext module resolution)
- pnpm workspaces for monorepo management
- Vitest for testing
- Zod for runtime validation
- Hono HTTP server with `@hono/zod-openapi` for route definitions and OpenAPI spec generation (server package)
- Drizzle ORM, dual-dialect: Postgres and SQLite via @libsql/client (server package)

## Dev commands

```bash
pnpm install          # install all dependencies
pnpm test             # run all tests once
pnpm test:watch       # run tests in watch mode
pnpm build            # build all packages
pnpm typecheck        # type-check all packages
pnpm lint             # lint all packages
pnpm lint:fix         # lint and auto-fix
pnpm format           # format all files with Prettier
pnpm format:check     # check formatting without writing
pnpm generate:openapi # generate OpenAPI spec from route definitions
```

## Worktree workflow

Long-lived worktrees that rebase `main` and pick up new workspace packages need a fresh `pnpm install` before they can build. `pnpm install --frozen-lockfile` is a near-instant no-op when the lockfile hash is unchanged, so the per-package `node_modules/.bin/` symlinks for newly-added packages never get linked, and the first `pnpm run build` then fails with `sh: tsup: command not found` from inside the affected package.

`pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error` to catch this: pnpm compares the `workspacePackagePatterns` in `node_modules/.modules.yaml` against the current workspace set and fast-fails with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` before any script runs. On that error, run plain `pnpm install` (not `--frozen-lockfile`) and retry. Don't bypass with `--no-verify` or work around the build — the state change is real and the install is the right fix.

## Authentication model

Two layers coexist permanently and don't share credentials:

- **Bearer tokens** (`marfa_k1_*` API keys, `marfa_at_*` OAuth access tokens) authenticate every API call to `/items`, `/edges`, etc. Hashed on storage; resolved by `middleware/auth.ts`.
- **Better Auth session cookies** authenticate the human at the consent screen. The library mounts at `/auth/*` via `app.on(["POST", "GET"], "/auth/*", ...)` after the explicit `/auth/clients`, `/auth/authorize`, `/auth/token`, `/auth/tokens` routes. Cookie is `HttpOnly + Secure + SameSite=Lax`, scoped to `/auth`. It does **not** authenticate the data plane: `/items` with only the cookie returns 401.

Better Auth tables (`auth_user`, `auth_session`, `auth_account`, `auth_verification`) are isolated under the `auth_*` prefix and use Drizzle's timestamp-mode columns (Date round-trip), distinct from marfa's TEXT-ISO convention elsewhere.

Email verification is required. New accounts sign up successfully but `auth_user.email_verified` starts `false`, and `requireEmailVerification: true` blocks sign-in until the user clicks a verification link. Migration `0042` (PG) / `0035` (SQLite) marks accounts predating the requirement as verified, so existing users aren't locked out. The verify-email surface is `/auth/verify-email`; the sign-up wrapper redirects to it after a successful sign-up.

Sign-in methods: email + password, passkey + magic link, generic OIDC client / federated, Marfa as IdP via OIDC Provider plugin.

User-app grants are stored as `system.connection` items with `kind: app`. The OAuth tables `oauth_codes` and `oauth_tokens` reference the item via `connection_item_id` (FK to `items.id`, ON DELETE CASCADE); the former standalone `oauth_grants` table is dropped. The same `system.connection` type carries the other kind shipped by the Connections build: `integration` (a connected upstream service such as Google Calendar).

The OAuth consent endpoints (`GET/POST /auth/authorize`) gate on the Better Auth session cookie, not admin bearer tokens. End users sign in via `/auth/sign-in` and approve their own grants; an unauthenticated request to `/auth/authorize` redirects to `/auth/sign-in?return_to=<original-url>`. Admin bearer tokens are still required for `/auth/clients` (client registration) and `/auth/tokens` (token management).

## System types

The reserved `system.*` namespace carries platform-internal items. All `system.*` types use a bounded lifecycle (`active | revoked` only, not the universal three-state). Only platform-flagged credentials (`is_platform: true`) can write `system.*` items; ordinary space credentials are rejected at `POST /items` regardless of `type_permissions`.

- `system.device` — connected devices (name, kind, last-active timestamp).
- `system.credential` — API keys and OAuth tokens (encrypted at rest under per-domain HKDF tags).
- `system.app` — registered app identities. Required before any `app.<app-name>.<type>` references resolve.
- `system.webhook` — outbound webhook subscriptions (URL, secret, event filters, delivery state).
- `system.connection` — approved relationships (the two kinds described under Authentication).
- `system.integration` — published Integration manifests. One row per `(name, version)` pair; the install pipeline persists the manifest onto the `system.connection` it produces.
- `system.activity` — operator-visible state: sync progress, errors, reauth prompts. Severity-tagged; the `severity: action_required` slice surfaces as a Repairs-style inbox.
- `system.account_holder` — the graph handle for the person who owns a space, so edges such as `authored-by` can name them. One row per space, created by the sign-up provisioning hook and backfilled for existing spaces. Carries no fields: the profile endpoints stay the source of truth, and the item id is exposed on the profile wire shape as `account_holder_item_id`.

## Reserved extension namespaces

The metadata-layer `extensions` map is otherwise free-form, but a handful of namespaces under `connection.*` are reserved with constrained write semantics. The canonical entry is **`connection.runtime`** — verbose per-Connection runtime state for `system.connection` items of kind `integration`: sync cursors, recent error tail, retry counters. Inbound-delivery idempotency sits alongside it in **`connection.runtime.idempotency`**, split out because it has a different writer. Writable only by the connection's own runtime credential; readable by space admins and the connection. `packages/server/AGENTS.md` carries the full list.

## Connections runtime substrate

Three coupled subsystems shipped together as the Connections build:

- **Connection OAuth proxy** — `POST /connections/:id/proxy/*` forwards to the connection's configured upstream URL with `Authorization: Bearer <decrypted access_token>`. Refreshes on 401 (single-flight, with refresh-token rotation) and flips `runtime_status: reauth_required` on terminal failure.
- **Connection leased tokens** — `/connections/:id/lease-tokens` issues short-TTL bearers that an upstream service can use to call back into Marfa directly without holding the connection's full credential. Manifest-capability gated.
- **Reactive run bridge + hop budget** — events published via `pubsub.publish` carry cycle-detection metadata (`originating_connection_id`, `hop_count`). The bridge fans out to subscribed connections; events whose `hop_count` exceeds the space's `max_event_hop_budget` are dropped and recorded as `system.activity` with `severity: error` so the user surface can show loop detection. The Cloudflare control plane (`runtime-control`) mints a short-lived per-connection broker key the Worker uses for callbacks.

**Two substrates run integrations.** The Cloudflare path above is the `hosted` substrate. The `local` substrate is a Node + pg-boss + `worker_thread` runtime bundled inside `@withmarfa/server` for self-hosters who don't want a Cloudflare dependency. The two are exclusive per-deployment via `MARFA_INTEGRATION_RUNTIME`; the handler authoring surface (`@withmarfa/runtime-sdk`) is identical on both. Component map is in `packages/server/AGENTS.md` under "Local integrations runtime"; the operator-facing semantic parity sheet is at `withmarfa/docs/guides/connections/runtime-substrates.mdx`.

For per-route specifics, including the OAuth bootstrap callback at `/oauth/callback` and the inbound webhook receipt URL pattern, see `packages/server/AGENTS.md`.

## Environment variables

Server package only (not needed for shared or SDK development):

- `PORT` — server port (default: 8600)
- `DB_DIALECT` — `sqlite` or `pg` (default: sqlite)
- `DATABASE_URL` — Postgres connection string (required when dialect is pg)
- `MARFA_DB_POOL_MODE` — `session` (default) or `transaction`, describing the endpoint `DATABASE_URL` points at. A direct Postgres connection is `session`. Set `transaction` when the app talks to a transaction-mode pooler (PgBouncer, Neon's `-pooler` endpoint); that makes `MARFA_DATABASE_URL_DIRECT` mandatory and the server refuses to boot without it. An unrecognized value throws at boot rather than falling back to the permissive mode.
- `MARFA_DATABASE_URL_DIRECT` — direct (unpooled, session-mode) URL for the same database as `DATABASE_URL`, used **only** by streaming RLS. Streaming issues a session-level `SET ROLE marfa_app`, which over a transaction-mode pooler strands on a shared backend and is inherited by later, unrelated queries — including Better Auth's session reads, which then fail with `permission denied`. Required when `MARFA_DB_POOL_MODE=transaction`; unnecessary otherwise, and streaming then shares the main client. It must address a **different endpoint** than `DATABASE_URL`: pointing it back at the pooled one satisfies every presence check while reproducing the failure exactly, so the server compares host and port and refuses to start when they match. Port is part of the comparison so the common self-hosted shape — PgBouncer beside Postgres on one machine — still starts.
- `SQLITE_PATH` — database file path (default: `./data/marfa.db`)
- `BLOB_BACKEND` — `filesystem` or `s3` (default: filesystem)
- `BLOB_PATH` — blob storage directory (default: `./data/blobs`)
- `MAX_BLOB_SIZE` — max blob upload size in bytes (default: `52428800` / 50MB). Oversized uploads return HTTP 413 `blob_too_large`.
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — S3 config
- `S3_ENDPOINT` — custom S3-compatible endpoint (MinIO, R2, etc.); optional
- `CDN_BASE_URL` — public CDN prefix rewritten onto blob URLs in responses; optional
- `API_KEY_SALT` — salt for key hashing (required in production)
- `CORS_ORIGINS` — allowed origins, comma-separated
- `AUTH_MODE` — `keys` (default) or `hosted` (multi-space with user accounts)
- `MARFA_PROCESS_ROLE` — `web | worker | both` (default: `both`). What this process does. `web` serves HTTP (API, SSE, webhook receipt, consent) and enqueues; `worker` runs the pg-boss consumers (scheduled jobs, integration dispatch, enrichment, bulk actions) behind a minimal `/health` endpoint on the same port. `both` is the single-container self-host shape and needs nothing set. Coordination goes through Postgres — events replicate over pg_notify, queues pin work, the consent lock is an advisory lock — so any mix of roles against one database is valid, and a role other than `both` therefore requires `DB_DIALECT=pg`. An unknown value refuses to boot.
- `MARFA_API_URL` — URL the local integration substrate's handlers write back through (default: `http://localhost:<PORT>`). The default is correct whenever the web tier shares the process; a split worker container points this at the web service.
- `MARFA_DB_POOL_SIZE` — main Postgres pool cap (default: 10); the session/streaming pool follows as `min(this, 5)`. Exists so a split deployment budgets web + worker under the database tier's connection ceiling — the arithmetic lives in the deployment's env template. A non-positive or non-integer value refuses to boot.
- `MARFA_REPLICA_COUNT` — how many server processes share this database. Purely declarative: it changes no behavior and exists so the boot-time multi-replica guard can warn. **SQLite only** — there realtime delivery (SSE, outbound webhooks) runs through a process-local emitter in `pubsub.ts`, so additional processes drop events silently. Postgres deployments replicate events between processes and skip the check entirely. Node cluster and PM2 workers are detected automatically; container orchestrators expose nothing readable, so set this when scaling a SQLite deployment that way.
- `MARFA_DEFAULT_QUOTA_ITEMS` / `_WEBHOOKS` / `_BLOBS` / `_STORAGE_BYTES` / `_RATE_PER_MINUTE` — default per-space ceilings. Unset = unlimited. Per-space `space_quotas` rows take precedence. All five (`items`, `webhooks`, `blobs`, `storage_bytes`, `rate_per_minute`) are enforced.
- `MARFA_RLS_ENFORCE` — when `true`, each space-bounded request is wrapped in a Drizzle transaction with `SET LOCAL ROLE marfa_app` and `set_config('marfa.space_id', $space, true)` so per-table RLS policies filter queries (defense-in-depth beneath application-layer scoping). **Defaults to `true`**; opt out with `false`. SQLite is unaffected (the middleware skips when `storage.pgDb` is undefined). Platform-admin keys (no space_id) and anonymous routes bypass the wrapper. Streaming responses apply session-level RLS on a reserved pool connection inside the route itself (`storage/pg/streaming-rls.ts`) — `/export` for its whole bounded response, `/events` only during its `Last-Event-ID` replay — exempt from the transaction wrapper but not from RLS.
- `RATE_LIMIT_REQUESTS` — requests per minute (default: 1000). GET requests get double this budget; per-path caps on auth surfaces override it (table in `packages/server/AGENTS.md`).
- `RATE_LIMIT_ENABLED` — `false` disables rate limiting entirely (on by default)
- `RATE_LIMIT_WINDOW_MS` — fixed-window length in ms (default: 60000). Shared by the per-credential, aggregate, and per-space windows; the per-space cap is named per-minute, so the two only agree at the default.
- `RATE_LIMIT_AGGREGATE_MULTIPLIER` — cap on one identifier's total across all path groups, as a multiple of `RATE_LIMIT_REQUESTS` (default: 4; `0` disables the aggregate window).
- `MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS` — cadence (ms) for the cluster-coordinated sweep that deletes expired `rate_limit_windows` rows (default: 3600000 / 1h).
- `ENABLE_HSTS` — `true` adds the Strict-Transport-Security header (only behind TLS)
- `TRUSTED_PROXY_CIDRS` — comma-separated CIDRs (e.g. `10.0.0.0/8,127.0.0.1/32`) for opt-in `x-forwarded-for` trust. Unset = ignore the header (recommended when no reverse proxy is in front). Malformed CIDRs throw at startup.
- `AUDIT_RETENTION_DAYS` — audit log retention in days (default: 90). Space override: `SpaceConfig.audit_retention_days`.
- `AUDIT_CLEANUP_INTERVAL_MS` — audit cleanup interval in ms (default: 86400000)
- `MARFA_EVENT_LOG_RETENTION_HOURS` — hours an event_log entry survives before the cleanup job purges it (default: 168 / 7 days). Bounds how far back an SSE client's `Last-Event-ID` can reach; older cursors get a terminal `catchup_too_old` event. Space override: `SpaceConfig.event_log_retention_hours`.
- `VERSION_RECENT_DAYS` — version recent window in days (default: 30)
- `VERSION_DAILY_SNAPSHOT_DAYS` — daily thinning window end in days (default: 90)
- `VERSION_WEEKLY_SNAPSHOT_DAYS` — weekly thinning window end in days (default: 365)
- `VERSION_MAX_VERSIONS` — hard cap per item (default: 500)
- `VERSION_THINNING_INTERVAL_MS` — thinning job interval in ms (default: 3600000)
- `TRASH_RETENTION_DAYS` — days a trashed item survives before hard-delete (default: 60; `0` disables). Space override: `SpaceConfig.trash_retention_days`. The env default applies to the NULL-space bucket and to spaces without an override.
- `TRASH_PURGE_INTERVAL_MS` — trash purge job interval in ms (default: 86400000)
- `AUTH_SESSION_CLEANUP_INTERVAL_MS` — cadence (ms) for the Better Auth session-cleanup sweep that drops `auth_session` rows past their `expires_at` (default: 3600000 / 1h). Instance-wide, not space-scoped — Better Auth owns the TTL.
- `MARFA_RUNTIME_CREDENTIAL_REAPER_INTERVAL_MS` — cadence (ms) for the runtime-credential reaper: revokes credentials past `expires_at`, drains credentials minted before expiry stamping once they age past the default TTL plus a one-TTL grace, and hard-deletes revoked runtime-credential rows after seven days (default: 3600000 / 1h; `0` disables). Instance-wide — expiry is a property of the row, not of space policy. The runtime-credential TTL itself is not env-tunable: it is derived from the substrate's dispatch bound because the local substrate cannot refresh a credential mid-run.
- `MARFA_ENRICHMENT_ENABLED` — deterministic text extraction from file blobs (default: on; `false` disables). A sweeper reads `core.file` items with a `blob_ref`, extracts text (plain text, the office and OpenDocument formats, embedded PDF text, image OCR) and writes it to `extracted_text` on the item, which the FTS indexer picks up on the same write. On by default because a document nobody can find is barely stored.
- `MARFA_ENRICHMENT_INTERVAL_MS` — sweep cadence in ms (default: 30000).
- `MARFA_ENRICHMENT_BATCH_SIZE` — items per sweep (default: 8). Extraction is CPU-bound and shares the event loop with the request path, so the batch is deliberately small.
- `MARFA_ENRICHMENT_ITEM_TIMEOUT_MS` — per-item extraction budget in ms (default: 60000). An overrun terminates the OCR worker, which is the only way to actually stop a recognition; the engine recreates it on the next call.
- `MARFA_ENRICHMENT_MAX_BLOB_BYTES` — blobs larger than this are skipped without being read (default: 20971520 / 20MB).
- `MARFA_ENRICHMENT_MAX_TEXT_CHARS` — extracted text is truncated to this length (default: 200000).
- `MARFA_ENRICHMENT_MAX_ATTEMPTS` — retries before a failing item stops being offered (default: 3).
- `MARFA_ENRICHMENT_OCR_ENABLED` — OCR of image files (default: on; `false` disables). Off means image items are recorded as unsupported and never retried, which is the right posture for a memory-constrained deployment: the wasm core is the heaviest thing extraction loads.
- `MARFA_ENRICHMENT_TESSDATA_DIR` — where the OCR language model is cached across runs (default: `./data/tessdata`). The model downloads on first use, so a writable path here is what stops every restart re-fetching it.
- `MARFA_SSE_MAX_VIEWERS` — ceiling on concurrent `/events` viewers per server instance (default: 0 = uncapped; a non-integer value refuses to boot rather than silently uncapping). A deliberate memory bound: a live viewer holds no database connection (only the `Last-Event-ID` replay briefly reserves one), so any limit here is a stated choice rather than a pool artifact. Exceeding it answers 503 `stream_capacity_exhausted`. Size it together with `MAX_SUBSCRIPTION_LISTENERS` below: each viewer holds two emitter listeners.
- `MAX_SUBSCRIPTION_LISTENERS` — the pubsub emitter's `setMaxListeners` ceiling (default: 100). Every SSE viewer holds one item and one edge listener, so a deployment raising the viewer cap past ~50 raises this in step or Node emits `MaxListenersExceededWarning` storms.
- `MARFA_HEARTBEAT_URL` — liveness heartbeat target (optional; unset = off). When set, the server GETs this URL on a timer so a watcher running elsewhere can alarm when the pings stop — a process cannot report its own death. A ping, not a report: no payload leaves the instance. Point it at any dead-man's-switch receiver.
- `MARFA_HEARTBEAT_INTERVAL_MS` — heartbeat cadence in ms (default: 60000). Ignored while `MARFA_HEARTBEAT_URL` is unset.
- `MARFA_DB_STARTUP_WAIT_MS` — how long boot waits for the database before giving up (default: 90000; `0` = fail fast). Connection-shaped failures retry with capped backoff and loud logs; misconfiguration still fails immediately. Exists so a database that returns slowly after a reboot produces a delayed clean start instead of a supervised crash loop.
- `ERROR_WEBHOOK_URL` — webhook URL for 500-error notifications (optional, debounced)
- `MARFA_ERROR_WEBHOOK_TIMEOUT_MS` — per-fetch timeout (ms) for error-webhook delivery (default: 5000), so a slow endpoint can't stall the error path.
- `MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS` — per-account throttle (ms) on cancel-email emission from the deletion-guard middleware; stops a sign-in flood minting fresh cancel tokens and emails for a pending-deletion account (default: 3600000 / 1h; `0` disables).
- `MARFA_AUTH_BASE_URL` — issuer URL the Better Auth instance is reached at. Drives cookie domains and the OAuth issuer field on the discovery doc (default: `http://localhost:<PORT>`).
- `MARFA_AUTH_ALLOW_SIGNUP` — when `true`, enables the email + password sign-up endpoint at `/auth/sign-up/email` (default: `false`). Single-user self-hosted instances flip it on for the initial admin account, then back off.
- `MARFA_AUTH_SECRET` — shared secret for cookie signing. Required in production; falls back to a per-process ephemeral secret in dev.
- `MARFA_OIDC_PROVIDERS` — JSON array configuring federated sign-in providers (Google, GitHub, Authentik, etc.). Each entry: `{ providerId, clientId, clientSecret, discoveryUrl?, scopes? }`. Surfaces `Sign in with <providerId>` buttons, signs in through `/auth/sign-in/social` and returns via `/auth/oauth2/callback/<providerId>`. Empty array (default) = no federated providers. A provider whose discovery endpoint cannot be reached is reported unavailable on `/health` and retried; it never stops the server from starting.
- `MARFA_EMAIL_BACKEND` — `cloudflare | smtp | none` (default: `none`). When `none`, email-dependent flows (forgot-password, magic-link, email-verify) return HTTP 503 `email_transport_not_configured` until an operator picks a backend. The factory at `src/email/index.ts` constructs the transport at boot.
- `MARFA_EMAIL_FROM` — visible sender address (default: `Marfa <hello@mail.marfa.so>`). **For the Cloudflare backend the address MUST end in `@mail.marfa.so`** — the verified Cloudflare Email sending domain. Apex `marfa.so` has no DKIM key. The boot-time `senderDomainCheck` fails loud on misconfiguration (skipped in `NODE_ENV=test`).
- `MARFA_EMAIL_REPLY_TO` — Reply-To header. Optional; recommend a monitored inbox so replies don't bounce silently.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id (the `marfa` org account). Required when `MARFA_EMAIL_BACKEND=cloudflare`.
- `CLOUDFLARE_EMAIL_API_TOKEN` — Cloudflare API token with "Send Email" permission on the marfa account. Required when `MARFA_EMAIL_BACKEND=cloudflare`. Mint a dedicated send-only token for least privilege rather than reusing a broad account-wide token.
- `MARFA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_SECURE` — SMTP backend config. Required when `MARFA_EMAIL_BACKEND=smtp`. Default port `587`. `MARFA_SMTP_SECURE=true` for implicit TLS (port 465); leave unset for STARTTLS on 587.
- `MARFA_INTEGRATION_RUNTIME` — `hosted | local` (**default: `local`**). `local` boots the Node + pg-boss + `worker_thread` substrate inside the server process and mounts `POST /runtime/webhook/:connection_id` as the inbound webhook receipt; requires `DB_DIALECT=pg`, so SQLite self-hosts must set `hosted` explicitly until they migrate. Hosted Marfa deployments and any operator wanting the Cloudflare path set `hosted` explicitly. Per-Connection state lives under the `connection.runtime` reserved namespace. See `packages/server/src/integrations/local-runtime/` and `withmarfa/docs/guides/connections/runtime-substrates.mdx`.
- `MARFA_INTEGRATIONS_ROOT` — absolute path to the `integrations/` directory the local runtime loads `dist/local.js` entries from. Defaults to the in-tree directory resolved from the running bundle; set explicitly when the server runs outside the monorepo (packaged Docker image, etc.).
- `MARFA_INTEGRATION_WORKER_THREADS` — worker threads per integration for the local substrate's executor (default: 2). Each thread pre-warms with its own resource-limit budget (64MB old-gen), so raising it is a memory sizing decision, not a free throughput dial. A value that is not a positive integer refuses to boot: a zero or NaN pool would leave every dispatch waiting on a slot that never comes.
- `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` — `hosted`-substrate only. JSON map of `integration_name → Cloudflare Queues producer URL`. Each reactive-`item-event` integration has its own queue (Cloudflare allows one consumer per queue; a shared queue would silently drop messages addressed to non-consumer integrations). Unset → bridge disabled. Malformed JSON or empty map → bridge disabled plus a loud error log. Unmapped integration at fanout → one-time `system.activity action_required` per integration per process lifetime, dispatch skipped.
- `MARFA_REACTIVE_RUN_SEND_TIMEOUT_MS` — per-fetch timeout (ms) for the `hosted`-substrate reactive-run bridge's Cloudflare Queues producer call (default: 5000). Only relevant when the bridge is wired (`CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` + `CLOUDFLARE_QUEUES_API_TOKEN` set).
- `MARFA_RUNTIME_CONTROL_URL` / `MARFA_RUNTIME_BROKER_KEY` — `hosted`-substrate only: the runtime-control plane URL and the platform broker key the server presents to mint per-Connection runtime credentials and to arm or disarm a schedule. Read by `routes/connections.ts`; unset on `local`-substrate deployments. The broker key travels only between the server and the control plane. Integration Workers hold a per-Worker key derived from a root the control plane alone holds (`MARFA_WORKER_IDENTITY_SECRET`), so no Worker can present a platform credential.

**Cloudflare Email Service setup.** The send domain `mail.marfa.so` is onboarded via the Cloudflare dashboard ("Email Service → Sending → Onboard Domain"); CF auto-writes DKIM, SPF, MX, and DMARC records under `cf-bounce.mail.marfa.so` to the `marfa.so` zone. Onboarding is dashboard-only — no programmatic API as of the public-beta phase. Send-time errors (suppressed recipients, validation failures) surface through structured logs; CF maintains its own suppression list, so the server holds no parallel `email_suppressions` state.

## Schema-enforcement levers

Three optional levers live in `SpaceConfig.enforcement` (writable via `PUT /spaces/me/config`), plus an optional per-credential `enforcement_override` on `ApiKey`. All three default off; flip on per-type to tighten validation:

- **Strict mode** — `enforcement.strict_mode.types: string[]`. For each listed type, unknown properties on writes are rejected with `INVALID_PROPERTIES` (`code: "unknown_property"`). The base `getZodSchema` flips from `z.looseObject` to `z.strictObject`.
- **Source allow-list** — `enforcement.source_allowlist.{types, sources}`. For each listed type, writes whose credential `source` isn't in the allowed sources are rejected with `FORBIDDEN`. Stricter than the credential's own scope.
- **Source filter** — `enforcement.source_filter.{types, sources}`. For each listed type, reads narrow to items whose `source` is in the allowed list. Filter-on-read, not enforcement-on-write: the read API silently omits rows that fail the filter.

Per-credential `enforcement_override` merges over the space default: setting `strict_mode` on a credential does not clear the space's `source_allowlist`.

## Platform credentials

The `is_platform: boolean` flag on `ApiKey` gates registration and writes of the reserved namespaces (`core.*`, `system.*`, `marfa.*`). The seed value lives on the bootstrap admin credential created at install; only an existing platform credential may mint another. Ordinary space admin/member keys default to `is_platform: false` and are rejected when they claim reserved namespaces.

## Database migrations

Drizzle migrations under `packages/server/drizzle/{pg,sqlite}/` are the schema source of truth. The bootstrap `SCHEMA_SQL` (imported by each dialect's `connection.ts` from a sibling `schema-sql.generated.ts`) exists only as the fresh-DB path for tests (`:memory:` SQLite) and new instances; it is generated from the migration chain and never hand-edited.

**Migrations are written by hand: SQL plus a journal entry.** There is no migration generator — the runtime migrator reads `meta/_journal.json` and the `.sql` files, nothing else.

When changing schema:

1. Update the Drizzle schema file(s) (`src/storage/pg/schema.ts` or `src/storage/sqlite/schema.ts`) so the ORM layer matches what the migration will create.
2. Hand-write the migration SQL as `drizzle/{pg,sqlite}/NNNN_short_slug.sql`, numbered one past the latest entry in that dialect's `meta/_journal.json`.
3. Add the matching entry to each `meta/_journal.json` (copy the previous entry's shape: bump `idx`, stamp `when` with current epoch millis, `tag` matches the filename without extension).
4. Regenerate the bootstrap blocks: `pnpm --filter @withmarfa/server run schema-sql:generate` (the PG half needs Docker for a transient `postgres:17`).
5. Apply to existing databases with `pnpm --filter @withmarfa/server run migrate`; `pnpm test:fresh-sqlite` and `pnpm test:pg` prove the chain and the bootstrap agree, and the `ci-fresh-migrate-{sqlite,pg}` jobs apply the whole chain to an empty database on every code PR.

FTS5 virtual tables stay inline in `sqlite/connection.ts` because the Drizzle schema can't express them. Don't add other inline DDL.

**Two migration-bearing pull requests open at once is a live hazard, and rebasing does not fix it.** The migrator selects pending work by comparing each journal entry's `when` against the newest `created_at` already applied (`Number(lastDbMigration.created_at) < migration.folderMillis`), and it never reads `idx` at all. So the second of two such branches to merge is applied only if its `when` is the later of the two — and if it is not, it is skipped **permanently and silently** on every database that already ran the first, while passing every fresh-database CI job, because an empty database has nothing to compare against. Renumbering the file and the `idx` during a rebase looks like it resolves the collision and does nothing about this. Before merging the second branch, re-stamp its `when` to the current epoch millis; the numbering is for humans, the timestamp is what the migrator obeys.

### Migrations on the hosted deploy (migrate-then-deploy)

The server does **not** migrate on boot. The hosted Cloudflare Containers deploy applies pending migrations as an explicit step **before** the container rolls — a schema-bearing image started against the old schema crash-loops (Cloudflare surfaces a generic "Failed to start container" 500 that masks the real cause). The canonical ordering is **migrate-then-deploy**.

- **Helper.** `infra/cloudflare/scripts/migrate-server-db.sh <staging|prod>` runs `pnpm --filter @withmarfa/server run migrate` with `DB_DIALECT=pg` and `DATABASE_URL` set to the env's **direct (unpooled)** Postgres URL. The migrator opens a single dedicated connection and runs DDL, which the pooled (transaction-mode PgBouncer) endpoint can't support, so migrations always use the direct URL while the running app uses the pooled URL.
- **Wiring.** `deploy-server-container.sh` calls the helper before `wrangler deploy` (skip with `SKIP_MIGRATE=1`). The `deploy-server-container.yml` workflow runs migrations in a dedicated `migrate` job that gates `deploy` (`deploy: needs: [build-push, migrate]`), so a failed migration blocks the rollout. A failed migration is always a hard stop — the container is never rolled against an unmigrated DB.
- **Per-env DB URLs.** Resolution is per-env, with a backward-compat fallback to the legacy shared name for staging:
  - staging direct: `NEON_DATABASE_URL_STAGING` → fallback `NEON_DATABASE_URL_MARFA`
  - prod direct: `NEON_DATABASE_URL_PROD`
  - staging pooled (app secret): `NEON_DATABASE_URL_POOLED_STAGING` → fallback `NEON_DATABASE_URL_POOLED_MARFA`
  - prod pooled (app secret): `NEON_DATABASE_URL_POOLED_PROD`
- **Forced roll.** The Worker rolls atomically on `wrangler deploy`; the container does not. It is replaced when it idles out for a whole `sleepAfter` window, and any request renews that window, so a build nobody can use stays resident precisely because its failing clients keep retrying. `MARFA_EXPECTED_IMAGE` carries the deployed tag into the Worker, and the first request that finds it disagreeing with the tag the instance started under stands the instance down (`server-container/src/roll.ts`). The `deploy` job then polls `/health` until it reports the deployed SHA and prints `roll_window_seconds`, so every deploy measures its own window rather than assuming one (`.github/observability/deploy-gate.mjs`).
- **Ordering rule: the tolerant side ships first, and the tolerant side is always the code.** An additive migration needs no ordering thought, which is the common case. When a change does need it, work out which side has to accept both the old and the new shape, and put that side in an earlier deploy. A migration can never be that side: it lands in one step and holds no opinion about what it meets.
  - **Tightening a constraint** (a new UNIQUE index, a new NOT NULL). The migration is intolerant, so the code that stops writing violating rows deploys first and the migration follows once nothing produces a row it would reject.
  - **A shape the running build cannot read** (`text` → `jsonb`, a renamed column). The _old build_ is intolerant, so deploy a reader that accepts both shapes, then migrate, then drop the tolerance in a third deploy. Expand and contract.

  This still applies now the roll is forced. Migrations run in an earlier job, so the old build serves the migrated schema for the length of the deploy job plus one request. The pipeline can't detect either case; it's per-migration authoring discipline.

## OpenAPI

Routes use `@hono/zod-openapi` with request/response schemas. The OpenAPI 3.1 spec is generated from route definitions, not maintained manually. Run `pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json` to update the committed spec. The spec is served at `GET /openapi.json` on a running server.

When adding or modifying routes, use `createRoute()` with Zod schemas for request params, body, and responses. Give every route an `operationId` — the internal-operation filter and the reference renderer both key on it. Streaming endpoints (SSE, NDJSON export) and HTML endpoints (OAuth consent) stay as plain Hono routes.

`AUTH_MODE` decides which route groups `createApp` mounts, so the committed spec is built by reflecting the app once per auth mode and unioning the results (`packages/server/src/openapi-published.ts`). Operations that only some modes serve carry `x-marfa-auth-modes` plus a note in their description; the rest are unmarked. Generating from a single mode would silently drop that mode's exclusive routes from the published reference. The live `/openapi.json` on a running server stays a single-mode document by design: it describes that deployment.

The `openapi-freshness` CI job regenerates and diffs `openapi.json` on every PR; spec drift fails the build with a regen instruction.

## Per-route tests

Every new HTTP route under `packages/server/src/routes/` ships with at least one smoke test in a sibling `*.test.ts` (auth gate + happy path minimum). PR review enforces. Pre-existing untested routes are exempt until modified.

## Freshness checks before merging

The `types-freshness`, `openapi-freshness`, and `schema-sql-freshness` CI jobs don't run on pull-request events — only on merges to `main` and manual dispatch — to keep PR CI cheap. If your PR modifies any source file below, you **must** fire the freshness workflow manually against the PR branch and confirm it passes before merging.

**Trigger files** — any change under these paths means you owe a freshness run before merge:

- `packages/types/core/**` — core type, system type and edge-type JSON
- `packages/types/integrations/**` — integration type JSON
- `packages/types/src/**` — schema shape contract and the shared schema validator
- `packages/types/scripts/**` — type-registry generator
- `packages/shared/src/**` — wire schemas, error codes, ID utilities
- `packages/server/src/routes/**` — route definitions that feed the OpenAPI spec
- `packages/server/src/openapi.ts`, `packages/server/src/openapi-finalize.ts` — OpenAPI generator
- `packages/server/drizzle/{pg,sqlite}/**` — Drizzle migrations (drive `SCHEMA_SQL`)
- `packages/server/scripts/generate-schema-sql.ts` — the `SCHEMA_SQL` generator
- Any file touched by `pnpm --filter @withmarfa/types generate`, `pnpm --silent --filter @withmarfa/server generate:openapi`, or `pnpm --filter @withmarfa/server schema-sql:generate`

**Command** — run from inside the `marfa` repo after pushing your PR branch:

```bash
gh workflow run ci.yml --ref <your-branch-name>
gh run watch $(gh run list --workflow=ci.yml --branch=<your-branch-name> --limit=1 --json databaseId --jq '.[0].databaseId')
```

If any of `types-freshness` / `openapi-freshness` / `schema-sql-freshness` fails, regenerate locally (`pnpm --filter @withmarfa/types generate`, `pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json`, or `pnpm --filter @withmarfa/server schema-sql:generate`), commit the delta, and re-run. Only merge once the relevant jobs are green.

**Why this exists.** Freshness jobs catch drift between generated artifacts and source files. They run on manual trigger rather than every PR push to keep the PR-time CI bill down (running on every push costs ~$5/month on the `marfa` repo alone); this rule is the tripwire that keeps the safety net effective.

## Before pushing

Two validation layers:

- **Pre-push git hook (slim)** — automatic, fast local feedback. Runs `build + typecheck + lint + format:check + test:changed` on every `git push` (build first so cross-package type resolution sees fresh `dist/*.d.ts`). `test:changed` scopes to tests whose files changed against `origin/main`; SQLite-only, target sub-30s. Installed via `git config --local core.hooksPath hooks`, which `pnpm install`'s `prepare` step sets automatically. Skippable with `git push --no-verify` for transient infra flake.
- **`ci.yml`** — the authoritative run: the full dual-dialect matrix on every PR, on self-hosted or GitHub-hosted runners (`CI_RUNNER`). This is the gate that decides mergeability.

For a full local check before opening a PR, `pnpm test:full` runs the whole dual-dialect matrix (`build + typecheck + lint + format:check + test:fresh-sqlite + test:pg + smoke:worker-entry + smoke:boot`) without a clean install — useful when the slim gate's diff-scoped tests don't reach what you've touched.

Per-target helpers for narrow runs:

- **`pnpm test:changed`** — `vitest run --changed origin/main`. Tests for files changed vs main.
- **`pnpm test:related <files…>`** — `vitest related --run …`. Tests depending on the listed source files. (vitest 4 made `related` a subcommand; the old `vitest run --related` flag is gone.)
- **`pnpm test`** — full SQLite suite, single run.
- **`pnpm test:fresh-sqlite`** / **`pnpm test:pg`** — single-dialect runs.

`test:pg` (and `test:full` through it) boots a throw-away `postgres:17` container per invocation. Container name and port carry the invoking shell's PID so concurrent runs across worktrees don't clobber each other. Requires Docker (OrbStack / Docker Desktop / compatible daemon).

CI runs this same script, so the two cannot drift. That is also why the missing-Docker behavior differs by environment: locally the script skips with a `⊘` message, so a contributor without a daemon is not blocked, while under `CI` it fails, because there the container is the only Postgres and a skip would report green having reached no database.

**Why slim by default.** A pre-push hook that runs the full ~1800-test dual-dialect suite invites `--no-verify` bypassing, and a hook that's bypassed isn't a gate. The slim gate gives fast feedback on what you touched; CI's full matrix is the authoritative dual-dialect check.

### A push costs machine time — verify locally first

Every job runs on the self-hosted pool, so a push costs no hosted minutes. It is not free: that pool shares one machine with whatever else is running on it, and **a whole matrix fires on every push to a pull request**. Several tests here fail on a fixed time budget when the machine is loaded, so a busy box manufactures failures that look like defects. Three rules follow, all of which come down to making the push the last step rather than the iteration mechanism:

- **Run `pnpm test:full` locally before pushing, not the hook.** It covers both dialects against a throwaway container, so it catches essentially everything CI would. The hook is SQLite-only and scoped to changed files; it has already gone green on a commit whose Postgres job failed.
- **Batch the work.** Several commits in one push cost the same as one. Pushing after each commit multiplies the load by the number of commits for no extra signal.
- **Never re-run CI to see whether a failure repeats.** Reproduce it locally instead. If a failure genuinely looks environmental, say so with the evidence rather than spending another matrix on the question — re-running until green is how a real defect gets waved through.

`workflow_dispatch` is cheap and safe to use: the heavy jobs skip on it deliberately, so a manual run costs only the three freshness jobs.

### Test infrastructure owns what it creates

Every machine resource a test or script allocates — a container, a volume, a temp directory, a background process — is released by the same code, in the same place, on every exit path, failure included. The failure mode this exists for is invisible by design: nothing breaks when a resource leaks, so the cost surfaces later as somebody else's slow CI or full disk. `docker rm` on a container that mounted an anonymous volume takes `-v`, or the volume outlives it with nothing left to reference it — that exact miss once leaked several gigabytes a night from this repo's Postgres test scripts. Review criterion: a change that allocates a machine resource states where it is released, and a cleanup path that only runs on success is a leak with extra steps.

## Deploy

`deploy.sh` at the repo root drives deployment against the operator's configured hosts: git pull + build + migrate + service restart. SSH options (`ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`) cap any transient hang at ~45s. Restarts use an atomic kill-and-relaunch so there's no port-handoff race. Service-log rotation runs as a separate per-host scheduled job; details (hostnames, service-manager labels, log-rotator paths) are operator-specific and live outside this repo.

## Error handling

The base error class is `MarfaError` (in `@withmarfa/shared`). All structured errors use it with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Three families of type ship with the platform, all registering into the same runtime registry and all resolving identically:

- **Core** (`packages/types/core/*.json`, 21 types) — the shared vocabulary: life-nouns any app can agree on.
- **Integration** (`packages/types/integrations/*.json`, 16 types) — one vendor's payload shape, so an integration has somewhere faithful to write. `google.*`, `raindrop.*`, `readwise.*`, `todoist.task`, `withmarfa.captured_email`, `withmarfa.podcast.*`.
- **System** (`packages/types/core/system/*.json`, 8 types) — platform-internal records, with the restrictions described under System types below.

The split is provenance, not behavior: it exists so a catalog can tell a space which types are the common vocabulary and which exist because a specific upstream service does. The codegen in `packages/types/scripts/generate.ts` emits one array per family into `generated/type-registry.ts`; shared bundles them at build time via tsup's `noExternal`. Schemas marked `_deferred: true` stay on disk as a record of shape but are skipped by the generator and excluded from the runtime registry. Custom types register at runtime via `POST /types` and persist in the `custom_types` table. Platform-shipped types — all three families — cannot be modified or deleted via the API.

**One validator across both authoring paths.** `validateTypeSchema` lives in `@withmarfa/types` and is called by the in-tree codegen and by `POST /types` alike, so an in-tree JSON schema is a valid runtime submission verbatim. Every error it raises carries `field`, `expected`, `actual` and `hint`. See `packages/types/AGENTS.md`.

Inheritance rule: child types may add new fields, and may re-state an inherited field only to sharpen its description or tighten it to required. Changing an inherited field's shape, or loosening a required field, is rejected with `inheritance_violation`.

Types may declare an optional `display_hints: { title_field?, body_field? }` block pointing generic readers at the canonical title/body fields; hints are inherited from the nearest ancestor when a subtype omits them.

Lifecycle is universal — the metadata-layer `state` axis is `active | archived | trashed`. Types do not declare their own state machines; `SYSTEM_TRANSITIONS` in shared is the authoritative graph.

## Edges

Relationships between items are first-class typed edges, not embedded references. Nine core edge types live as JSON under `packages/types/core/edges/` and seed the in-memory registry at startup: `about`, `parent-of`, `in-collection`, `in-thread`, `attached-to`, `references`, `authored-by`, `derived-from`, `supersedes`. Each carries cardinality (`one-to-one` / `one-to-many` / `many-to-one` / `many-to-many`), `cascade_on_delete` (`cascade` / `orphan` / `block`), and source / target type constraints.

**Direction is spec-exact.** For `parent-of`, source = parent, target = child. For `in-thread`, source = member, target = thread. Every consumer (cycle-detection walks, filter SQL, cascade planner) obeys this.

Custom edge types register at runtime via `POST /edge-types` (space-admin or platform-admin) and persist in `custom_edge_types`. They're space-scoped: a space's custom edge types resolve only within that space (composite `(space_id, id)` PK plus a per-space in-memory registry), while the nine core types stay global. Two spaces may register the same id independently. Core types cannot be redefined. Custom edge types do not inherit.

Atomic writes on `POST /items` accept `edges: { [type]: [target_ids] }`. Edge-only mutations go through `/edges` (create / update-properties-only / delete) or `/items/:id/edges` + `/backrefs` for listings. Single-item reads hydrate edges inline; list reads opt in via `?include=edges`.

Query-language filters use `edge[<type>]=<target_id>` (outbound) and `backref[<type>]=<source_id>` (inbound). Both work on `GET /items` and `/search`.

## Permissions

Credentials carry three permission maps:

- `type_permissions` — `{ "<type_pattern>": "read" | "write" | "none" }`. Pattern supports `*` wildcard and `parent.*` subtree.
- `extension_permissions` — `{ "<namespace>": "read" | "write" }`. Scoped to `/items/:id/extensions/:namespace`.
- `edge_permissions` — `{ "<edge_type>": "read" | "write" }` with `*` wildcard. Enforced via `requireEdgePermission` on `POST /edges`, `PATCH /edges/:id`, `DELETE /edges/:id`, and any `POST /items` carrying an `edges` payload.

Edge mutations dual-gate: the caller needs **both** write on the source item's type AND write on the edge type. Admin keys bypass both.

OAuth scope grammar mirrors these: `<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`, `metadata.<subresource>:<verb>`. Scopes parse via `parseScope` in `@withmarfa/shared`; the consent UI renders both the literal scope and a plain-English description sourced from each type's `description` field in `TYPE_REGISTRY` (with built-in fallbacks for metadata sub-resources). Two sub-resource scopes are enforced: `metadata.types:write` gates `POST /types` and `metadata.edge_types:write` gates `POST /edge-types`, both for non-admin credentials. Admin keys bypass; OAuth tokens project the scopes into the `metadata_permissions` map on the synthetic `ApiKey`.

New keys default to `edge_permissions: {}` — edge access is opt-in; callers must grant explicitly.

`metadata_permissions` is the parallel map for metadata-layer mutations, keyed by sub-resource (today: `types` and `edge_types`); default `{}` for new keys. `requireMetadataPermission(c, subresource, "write")` admits admin keys, member keys carrying the matching map entry, and OAuth tokens whose grant carries the matching `metadata.<subresource>:write` scope.

## Webhooks

Outbound webhooks fire on item events (`item.created`, `item.updated`, `item.deleted`, `item.restored`, `item.state_changed`), metadata changes (`metadata.changed`), and edge lifecycle events (`edge.created`, `edge.deleted`). The `WebhookConsumer` runs one subscription per event family and delivers to registered URLs with HMAC-SHA256 signatures plus exponential-backoff retry.

## Code style

- American English: color not colour, organization not organisation, favorite not favourite. Applies to code, comments, commits, and docs.
- ESM-only: `import`/`export`, never `require()`
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files, per NodeNext resolution)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Named exports only, no default exports

### Boolean naming

Name a boolean so it reads as a yes/no. Three valid shapes:

- **Bare** for adjectives and participles — `active`, `verified`, `disabled`, `public`, `succeeded`. These already read as a yes/no.
- **Prefixed** for state and possession — `is_` for state (`is_platform`), `has_` for possession (`has_more`).
- **Verb-led** for action directives — `force_` / `skip_` / `enable_` (`force_snapshot`, `skip_consent`, `enable_end_session`). Use these for a boolean that tells the system to _do_ something, where a state prefix would misdescribe it.

A bare noun reads as neither yes nor no — rename it to one of the shapes above. Applies to wire fields, DB columns, and in-code variables alike.

### One word: "space"

An isolated data boundary is a **space**, in code, in schemas, in DB columns, on the wire, in the role vocabulary (`space_admin`) and in anything a person reads. There is no second term and no translation step.

The code used to say `tenant` while everything user-facing said "space". That split cost a translation on every route, log line and error message, forever, to save a reader learning one word once, and the word it protected was the less precise of the two anyway: a space is usually one person rather than an organization. Not "instance", which is a server deployment, and not "workspace", which oversells the team angle.

The old term survives in exactly two places, both immutable: applied database migrations, and commit history. Anywhere else it is a missed rename rather than a compatibility shim, so remove it if dead and update it if live.

## Comments

Comments are self-contained and make sense to anyone reading this repository cold. Explain _why_ — the decision, constraint, or non-obvious trade-off — not the _what_, which the code already states. Never reference internal trackers, ticket numbers, or project phases; a comment that only points at external context is noise. If a comment doesn't earn its place by capturing intent, delete it — the code and its history carry the rest.

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`.
