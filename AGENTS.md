# Marfa

Typed data layer. This monorepo holds eight active workspace packages and the DigitalOcean infra directory.

**Docs MCP convention.** When working on documented surfaces (types, edges, runtime substrates, connections, auth flows), query the docs MCP at `https://docs.marfa.so/mcp` (or `marfa docs search "<query>"` from the CLI) before re-deriving from source.

**Docs roles.** Published docs live **only** in `withmarfa/docs` — never author docs pages in this repo. In-repo READMEs stay tight (what the repo is, how to build and run it, where canonical docs live); AGENTS.md carries agent and build context. When a change touches a public surface, open a companion `withmarfa/docs` PR as part of the same change and link it from this PR.

**Core packages (`packages/`):**

- **@withmarfa/types** — JSON schemas for the platform-shipped type set, the validator both authoring paths share, plus the generate script that emits the TypeScript registries (`ALL_TYPES`, `ALL_INTEGRATION_TYPES`, `ALL_SYSTEM_TYPES`, `ALL_EDGE_TYPES`). Consumed by `@withmarfa/shared`; private (bundled into shared's dist, not published).
- **@withmarfa/shared** — Wire types, Zod validation schemas, error codes, type-registry consumer, ID utilities, the OAuth scope grammar parser, the `IntegrationManifestSchema`. The foundation every other package imports.
- **@withmarfa/server** — Hono HTTP server exposing the Marfa API (private). Carries the data plane plus the Connections / OAuth / Better Auth surfaces.
- **@withmarfa/sdk** — TypeScript HTTP client. The `@withmarfa/sdk/auth` subpath holds the OAuth helpers (`MarfaAuth`, PKCE helpers, token storages, `startDeviceFlow`); `@withmarfa/sdk/auth/node` holds the Node-only pieces — the shared `~/.marfa/<instance>.json` credential store and its file-backed `TokenStorage` — kept separate so browser bundlers never see `node:fs`.
- **@withmarfa/webhooks** — Inbound-webhook signature verification (HMAC-SHA256, Slack, Stripe, GitHub). Web Crypto only, consumed by the server's webhook-receipt route.
- **@withmarfa/runtime-sdk** — SDK consumed by Integrations. Dispatch engine, per-connection state, connection client, echo suppression, manifest-typed handler scaffolding.
- **@withmarfa/runtime-test** — Test harness mirroring the runtime-sdk surface (in-memory queue + `consumeBatch` driver), so Integrations can unit-test their handlers without booting the server.
- **@withmarfa/sync-manifest** — The manifest the sync client installs against. Sync watches a filesystem, so its code runs on the user's machine and there is nothing for a deployment to install; the server imports this manifest and hands it to the boot-time catalog reconcile. Private, and not an Integration for exactly that reason.

**Integrations live in `withmarfa/integrations`.** Each is a package at `packages/<namespace>/<name>`, mirroring its manifest identifier, and that repository's own `AGENTS.md` is the authority on them. The server image installs the set `packages/server/installed-integrations.txt` declares, built from the commit `packages/server/integrations-ref.txt` pins. **That declaration and the registry at the pinned commit are held to each other by the image build**, which is the only place both are readable: the declared set has to be exactly the registry entries marked `shippedByMarfa`. A registry entry merged there changes nothing here until the pin moves, which is the point: the check guards the image rather than the other repository.

**Where the code has to run is what decides whether something is an Integration.** An Integration is installed into a deployment's integrations directory and dispatched by the runtime. A client's code can only run somewhere else: sync watches a filesystem, so it runs on the machine holding the files. It ships a manifest and no handler, and that manifest ships with the server build rather than being installed. Sync keeps its Connection, credentials, configuration and observability either way; none of that is what makes something an Integration.

**Infra (`infra/`):** `digitalocean` — compose files, Caddyfile, env templates, and the deploy shape for the droplet deployments (`deploy-server.yml` targets it).

`@withmarfa/shared`, `@withmarfa/sdk`, `@withmarfa/runtime-sdk`, `@withmarfa/runtime-test`, and `@withmarfa/webhooks` publish to npm under the `@withmarfa` scope via OIDC trusted-publisher (`.github/workflows/publish.yml`), fired on `v*` tag pushes. Other workspace packages are private.

`publish.yml` publishes sequentially in one job, in this order: `@withmarfa/shared` → `@withmarfa/sdk` → `@withmarfa/runtime-sdk` → `@withmarfa/runtime-test` → `@withmarfa/webhooks`. The order is load-bearing: `pnpm pack` resolves a `workspace:*` dependency to a concrete version number, so packing a package before the version it names exists on the registry produces a tarball nobody can install. **`@withmarfa/sdk` sits in the middle of that chain and is easy to leave out of a mental model of it** — `runtime-sdk` depends on it, so a sequence that skips it packs `runtime-sdk` against a version the registry does not have.

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
- **Reactive bridge + hop budget** — events published via `pubsub.publish` carry cycle-detection metadata (`originating_connection_id`, `hop_count`). The bridge fans out to subscribed connections; events whose `hop_count` exceeds the space's `max_event_hop_budget` are dropped and recorded as `system.activity` with `severity: error` so the user surface can show loop detection.

**Integrations run in-process.** The runtime is a Node + pg-boss + `worker_thread` substrate bundled inside `@withmarfa/server`; it requires Postgres, so SQLite deployments run without integrations. Component map is in `packages/server/AGENTS.md` under "Local integrations runtime".

**A dispatch that gives up degrades `/health`.** When a dispatch exhausts its retries, `/health` reports a `dead_letters` component and the overall status goes `degraded`, which is what the external poller keys on — no new credential, no second notifier. It carries **a count and nothing else**: the admin listing over the same rows returns connection identifiers spanning every space, and `/health` is unauthenticated. `POST /admin/runtime/dead-letters/{id}/replay` clears it. Two things to know about the shape: `/health` still answers 200 when degraded, so the container's own liveness probe is unaffected, and the evidence expires, because pg-boss deletes a failed row seven days after it fails. The row goes at seven days whether or not anyone was told, so an untouched alert resolving itself is a reason to act on it rather than a reason not to raise it.

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
- `API_KEY_SALT` — HMAC key for API-key hashing (required in production). **Per environment, never shared.** Changing it invalidates every key minted against that deployment and cannot be repaired through the API, because `POST /keys` bootstrap mode engages only on a server with zero key rows rather than zero valid ones.
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
- `MARFA_AUTH_SECRET` — cookie signing, and the HKDF input deriving the AES-256-GCM key that protects stored connection tokens, inbound webhook secrets, OAuth callback state and credential rows. Required in production; falls back to a per-process ephemeral secret in dev. **Per environment, never shared** — a copy in a looser environment's file is that environment holding the stricter one's at-rest key. Changing it makes every existing ciphertext unreadable, so it is a data-destroying operation rather than an environment-file edit.
- `MARFA_OIDC_PROVIDERS` — JSON array configuring federated sign-in providers (Google, GitHub, Authentik, etc.). Each entry: `{ providerId, clientId, clientSecret, discoveryUrl?, scopes? }`. Surfaces `Sign in with <providerId>` buttons, signs in through `/auth/sign-in/social` and returns via `/auth/oauth2/callback/<providerId>`. Empty array (default) = no federated providers. A provider whose discovery endpoint cannot be reached is reported unavailable on `/health` and retried; it never stops the server from starting.
- `MARFA_EMAIL_BACKEND` — `cloudflare | smtp | none` (default: `none`). When `none`, email-dependent flows (forgot-password, magic-link, email-verify) return HTTP 503 `email_transport_not_configured` until an operator picks a backend. The factory at `src/email/index.ts` constructs the transport at boot.
- `MARFA_EMAIL_FROM` — visible sender address (default: `Marfa <hello@mail.marfa.so>`). **For the Cloudflare backend the address MUST end in `@mail.marfa.so`** — the verified Cloudflare Email sending domain. Apex `marfa.so` has no DKIM key. The boot-time `senderDomainCheck` fails loud on misconfiguration (skipped in `NODE_ENV=test`).
- `MARFA_EMAIL_REPLY_TO` — Reply-To header. Optional; recommend a monitored inbox so replies don't bounce silently.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id (the `marfa` org account). Required when `MARFA_EMAIL_BACKEND=cloudflare`.
- `CLOUDFLARE_EMAIL_API_TOKEN` — Cloudflare API token with "Send Email" permission on the marfa account. Required when `MARFA_EMAIL_BACKEND=cloudflare`. Mint a dedicated send-only token for least privilege rather than reusing a broad account-wide token.
- `MARFA_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_SECURE` — SMTP backend config. Required when `MARFA_EMAIL_BACKEND=smtp`. Default port `587`. `MARFA_SMTP_SECURE=true` for implicit TLS (port 465); leave unset for STARTTLS on 587.
- `MARFA_INTEGRATIONS_ROOT` — absolute path to the directory the integration runtime loads `<namespace>/<name>/dist/local.js` entries from. No default: the packaged image points it at the tree it staged, and a deployment carrying integrations any other way sets it to wherever they are. Unset means the deployment installs none, which the boot log says.
- `MARFA_INTEGRATION_WORKER_THREADS` — worker threads per integration for the runtime's executor (default: 2). Each thread pre-warms with its own resource-limit budget (64MB old-gen), so raising it is a memory sizing decision, not a free throughput dial. A value that is not a positive integer refuses to boot: a zero or NaN pool would leave every dispatch waiting on a slot that never comes.
- `MARFA_INTEGRATION_DISPATCH_CONCURRENCY` — how many integration dispatches one process runs at once (default: 2). Sized against the session connection pool rather than against throughput. A dispatch takes the per-connection advisory lock and holds a reserved session connection for its whole run, tens of seconds rather than the milliseconds a job tick holds one — and **that pool holds at most five connections whatever anything is set to**: it is built as `min(MARFA_DB_POOL_SIZE, 5)`, so that variable can only ever lower it. Those five are shared with streaming reads, the consent lock and every other job lock, and one of those is on a request path that turns a lost reservation into a user-visible refusal. Raising this is therefore a decision about who else goes without, not a dial with a matching pool setting; past three, dispatches start losing the reservation budget and are acked and dropped at a lock nobody holds. It should also not exceed `MARFA_INTEGRATION_WORKER_THREADS`: two dispatches of one integration need two threads in its pool, and with one the second is rejected rather than queued. Per-connection serialization does not depend on it — the advisory lock still admits one dispatch per connection whatever the number. A value that is not a positive integer refuses to boot.

**Cloudflare Email Service setup.** The send domain `mail.marfa.so` is onboarded via the Cloudflare dashboard ("Email Service → Sending → Onboard Domain"); CF auto-writes DKIM, SPF, MX, and DMARC records under `cf-bounce.mail.marfa.so` to the `marfa.so` zone. Onboarding is dashboard-only — no programmatic API as of the public-beta phase. Send-time errors (suppressed recipients, validation failures) surface through structured logs; CF maintains its own suppression list, so the server holds no parallel `email_suppressions` state.

## Schema-enforcement levers

Three optional levers live in `SpaceConfig.enforcement` (writable via `PUT /spaces/me/config`), plus an optional per-credential `enforcement_override` on `ApiKey`. All three default off; flip on per-type to tighten validation:

- **Strict mode** — `enforcement.strict_mode.types: string[]`. For each listed type, unknown properties on writes are rejected with `INVALID_PROPERTIES` (`code: "unknown_property"`). The base `getZodSchema` flips from `z.looseObject` to `z.strictObject`.
- **Source allow-list** — `enforcement.source_allowlist.{types, sources}`. For each listed type, writes whose credential `source` isn't in the allowed sources are rejected with `FORBIDDEN`. Stricter than the credential's own scope.
- **Source filter** — `enforcement.source_filter.{types, sources}`. For each listed type, reads narrow to items whose `source` is in the allowed list. Filter-on-read, not enforcement-on-write: the read API silently omits rows that fail the filter.

Per-credential `enforcement_override` merges over the space default: setting `strict_mode` on a credential does not clear the space's `source_allowlist`.

## Platform credentials

The `is_platform: boolean` flag on `ApiKey` gates item writes into the reserved namespaces (`core.*`, `system.*`, `marfa.*`) and exempts the publisher-handle ownership rule at type registration. It does not admit reserved-namespace registration: `POST /types` refuses a reserved-root type for every credential, platform included. The seed value lives on the bootstrap admin credential created at install; only an existing platform credential may mint another.

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

### Migrations on deploy (migrate-then-deploy)

The server does **not** migrate on boot. The deploy applies pending migrations as an explicit step **before** the stack rolls — a schema-bearing image started against the old schema crash-loops. The canonical ordering is **migrate-then-deploy**.

- **Wiring.** `deploy-server.yml` runs the one-shot `migrate` compose service on the droplet (`docker compose run --rm migrate`) after pulling the new image and before rolling the stack, then gates on `/health` reporting the deployed SHA. The roll uses `up -d --no-deps` deliberately, so compose never re-evaluates the migrate service's completed condition. A failed migration is a hard stop — the stack is never rolled against an unmigrated database.
- **Direct endpoint for DDL.** The migrator opens a single dedicated connection and runs DDL, which a transaction-mode pooled endpoint can't support. When the deployment's app traffic runs through a pooler, migrations use the direct URL; the droplet deployments connect in session mode, where the same URL serves both.
- **Ordering rule: the tolerant side ships first, and the tolerant side is always the code.** An additive migration needs no ordering thought, which is the common case. When a change does need it, work out which side has to accept both the old and the new shape, and put that side in an earlier deploy. A migration can never be that side: it lands in one step and holds no opinion about what it meets.
  - **Tightening a constraint** (a new UNIQUE index, a new NOT NULL). The migration is intolerant, so the code that stops writing violating rows deploys first and the migration follows once nothing produces a row it would reject.
  - **A shape the running build cannot read** (`text` → `jsonb`, a renamed column). The _old build_ is intolerant, so deploy a reader that accepts both shapes, then migrate, then drop the tolerance in a third deploy. Expand and contract.

  This still applies now the roll is forced. Migrations run in an earlier job, so the old build serves the migrated schema for the length of the deploy job plus one request. The pipeline can't detect either case; it's per-migration authoring discipline.

## Narrowing a contract that stored rows already match

Several contracts here are validated against **stored** data on every read rather than only at write: the integration manifest most of all, which is re-parsed on every resolution, with `.strict()`, and a runtime credential's permissions projected from the result. A mint fails closed, so a resolution failure is not a degradation, it is a stop.

Each part of that is correct on its own, and together they mean **a narrowing has no grace period unless you write one**.

**Enumerate everything the change tightens, not the thing that prompted it.** Removing one required field from the manifest shipped with a tolerance for that field, written deliberately by someone who knew the hazard. But dropping a required field is not additive, so the same change moved the schema major, and the supported-major gate then refused every row written under the old one. Eleven of eleven staging connections stopped resolving, naming a version no user had ever set. The tolerance was real and covered a third of what the change did, which reads exactly like covering all of it until deploy.

The list to walk before narrowing:

- the field or shape itself,
- the contract or schema **version gate**, if the change moves a major,
- any **strictness** that now rejects what the old shape carried,
- any **second validator** over the same document.

**Then replay the new validator over real stored rows before trusting the tolerance.** Pull every row the validator will meet on the deployed environments and run it locally. It takes minutes, it is the step that was skipped, and it is what has since proved a follow-on migration safe. Verifying after deploy is where the recovery time goes.

## OpenAPI

Routes use `@hono/zod-openapi` with request/response schemas. The OpenAPI 3.1 spec is generated from route definitions, not maintained manually. Run `pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json` to update the committed spec. The spec is served at `GET /openapi.json` on a running server.

When adding or modifying routes, use `createRoute()` with Zod schemas for request params, body, and responses. Give every route an `operationId` — the internal-operation filter and the reference renderer both key on it. Streaming endpoints (SSE, NDJSON export) and HTML endpoints (OAuth consent) stay as plain Hono routes.

`AUTH_MODE` decides which route groups `createApp` mounts, so the committed spec is built by reflecting the app once per auth mode and unioning the results (`packages/server/src/openapi-published.ts`). Operations that only some modes serve carry `x-marfa-auth-modes` plus a note in their description; the rest are unmarked. Generating from a single mode would silently drop that mode's exclusive routes from the published reference. The live `/openapi.json` on a running server stays a single-mode document by design: it describes that deployment.

The `openapi-freshness` CI job regenerates and diffs `openapi.json` on any pull request touching a route definition, the generator, or the wire schemas; spec drift fails the build with a regen instruction.

## Per-route tests

Every new HTTP route under `packages/server/src/routes/` ships with at least one smoke test in a sibling `*.test.ts` (auth gate + happy path minimum). PR review enforces. Pre-existing untested routes are exempt until modified.

## Freshness checks

The `types-freshness`, `openapi-freshness` and `schema-sql-freshness` jobs regenerate a committed artifact and fail on drift. **They are ordinary pull-request checks: there is nothing to fire by hand.** Each runs only when the pull request touches a path that can actually stale the artifact it checks, so a pull request that cannot break one pays nothing for it.

**Trigger paths**, one set per job. `ci.yml`'s `changes` job holds the same list; keep the two in step.

- **Types codegen** — `packages/types/{core,integrations,src,scripts,generated}/**`: the core, system, edge-type and integration JSON, the schema shape contract and shared validator, the type-registry generator, and its output.
- **OpenAPI spec** — the above, plus `packages/server/src/routes/**`, `packages/server/src/openapi*.ts`, `packages/shared/src/**` (wire schemas, error codes, ID utilities), and `openapi.json`.
- **SCHEMA_SQL** — `packages/server/drizzle/{pg,sqlite}/**`, `packages/server/scripts/generate-schema-sql.ts`, and `packages/server/src/storage/{pg,sqlite}/schema-sql.generated.ts`.

Each set covers the generated artifact as well as its sources. That is the one path where a hand-edit is itself the defect, and without it a pull request touching only the generated file would run no check at all.

When one fails, regenerate locally, commit the delta and push:

```bash
pnpm --filter @withmarfa/types generate
pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json
pnpm --filter @withmarfa/server schema-sql:generate
```

**Why they became real checks.** They ran only on `main` and on manual dispatch, to keep pull-request CI cheap, and the compensating control was a written rule: fire the workflow by hand against your branch when you touch a trigger path, and read the result before merging. That control failed the first time it mattered. The dispatch was fired as the rule required. It failed. The pull request merged eleven minutes later on its own green checks, because the job that would have objected does not run there, and `main` stayed red until a follow-up regenerated the file. A gate that depends on someone remembering to ask a question, and then remembering to read the answer, is not a gate.

The cost that justified the exclusion also moved: it was billed minutes on hosted runners, and CI runs on a self-hosted pool now. What remains is machine time on a shared box, which the path filters keep off the majority of pull requests.

### A red `main` says which kind of red

`ci.yml`'s `notify` job reports `main`'s verdict to the alerting service, and distinguishes a test failure from a job that never ran.

**The two mean opposite things.** A test failure says the commit is bad. An abandonment says nothing at all about the commit, and every later pull request is then measured against a baseline nobody has information about. Two runs were once abandoned when the host ran out of ephemeral TCP source ports and the runners' own lease-renewal loop could not open a socket; both reported `failure`, neither had run a failing test, and the only place that said so was a log file on the machine.

**The distinction is clean through the API**, which is what makes this cheap: an abandoned job has no step whose conclusion is `failure` and at least one that is `cancelled`, while every genuine failure has exactly one failing step. When it fires, the alert names the affected jobs and says to re-run rather than read it as a defect.

`main` only. A pull request's red is already in front of whoever pushed it. Hosted, like every notifier here, because a notifier on the pool cannot report that the pool is broken, which in this job's case is the whole point.

**Two cases are deliberately silent**, and a reader whose alert never resolved should look here first. A run **cancelled as a whole** is skipped: `always()` includes the cancelled case, and the concurrency group supersedes a main run whenever two merges land inside one matrix, so reporting it would alert on a commit the newer run already covers. A **green verdict on a merge the `changes` job called non-code** is not reported either: the two dialect jobs gate at step level and report success without running anything, so resolving on that would close an alert about a red `main` that nothing has re-tested. In both, a genuinely open alert stays open until something actually runs, which is the right direction.

### The image build

`Server image` (`.github/workflows/image-build.yml`) builds the container image and throws it away. It runs **on merges to `main`** when a path it is gated on changes, and on manual dispatch against any branch.

**The only jobs that build the image are this one and the deploy's `build-push`**, plus `docker-compose.yml` on a self-hoster's machine, which no job here runs. So anything the image build does differently reaches CI only through this workflow, and before it existed the first report was a broken deploy on a green `main`. A bundler heap ceiling is the one that bit first; the enduring list is the `linux/amd64` target, the install against the committed lockfile, the integration staging step, and the runtime stage's file layout.

- **Trigger paths** — `packages/server/Dockerfile`, any `.dockerignore`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, any `package.json`, any `tsup.config.ts`, `packages/server/scripts/**`, `packages/server/installed-integrations.txt`, `packages/server/integrations-ref.txt`, `packages/server/fixtures/**` (the dispatch fixture, which the image builds and stages exactly as it does an integration entry), and the workflow file itself.
- **Deliberately not every source file.** Roughly a quarter of merges touch that set, so growth in the sources this build is sensitive to meets a build within hours rather than needing its own trigger.
- **Hosted, not the self-hosted pool.** The pool is arm64 and the image is `linux/amd64`; emulated cross-building is far slower than a native build. Same reason the deploy's `build-push` job is hosted. A green build is about two and a quarter minutes.
- **The whole image, not `--target build`.** Stopping at the build stage skips the runtime layout and the check that the staged integrations can load. Those are seconds on top. The saving is in dropping `--push`, which also means the job needs no registry credential.
- **Its own workflow rather than a job in `ci.yml`, and that is load-bearing.** `ci.yml` cancels a superseded run so two Postgres-bearing matrices never contend for one machine. That is right for the matrix and wrong here: a merge landing inside the build window would cancel the previous merge's image build, and `ci.yml`'s path gating derives from `github.event.before`, so the newer run would compute its own diff, find no image path in it, and skip the build entirely. Here the gate is the workflow's own `paths:`, so a push either produces a run or produces nothing, and `cancel-in-progress: false` lets an in-flight build survive a newer push rather than being dropped. These runs cost the hosted allowance rather than the shared pool, so letting them overlap contends with nothing.
- **A red image build alerts.** The workflow carries its own `notify` job, hosted, like every other notifier here.

**Dispatching it is not free.** Unlike a `ci.yml` dispatch, a `Server image` dispatch always runs the full amd64 build. That is the point of having it — it is how a Dockerfile change gets checked before it merges — but it is billed hosted minutes rather than pool time.

### The integrations pin

`Integrations pin drift` (`.github/workflows/integrations-pin-drift.yml`) says when `packages/server/integrations-ref.txt` has fallen behind something the image would ship. Daily at 07:42 UTC, plus dispatch. Hosted, with its own `notify` job.

**It compares built output rather than changed paths**, and that is the whole design. esbuild discards ordinary comments unconditionally, so a JSDoc-only edit to a manifest and a comment-only edit to a handler both produce a byte-identical bundle, and those edits dominate that repository's history. Any path filter wide enough to catch a real source change catches them too, so the obvious version of this guard reports noise on its first run. Paths decide only whether the comparison is worth doing: they narrow to declared packages plus everything outside `packages/`, then exclude what no bundle can carry, and an unrecognised path is compared rather than passed.

**It also asks the question the image build asks, a day earlier.** The image build holds the registry at the _pinned_ commit; this holds `main`'s, so a new integration merged there and marked `shippedByMarfa` is reported the next morning rather than whenever somebody next moves the pin.

**Hosted, not the pool.** Two installs and two builds of a fifteen-package workspace, on a timer, unattended. The pool is one shared machine serving every pull request in the estate, and several suites fail on fixed time budgets, so a scheduled pair of builds landing there manufactures failures in whatever else is running. It is pinned to `ubuntu-latest`, so it caches unconditionally, as `publish.yml`'s two jobs do for the same reason: a runner fixed to a hosted label keeps no store between runs, and needs no expression to work that out.

### Where the dependency cache is allowed

**Every `actions/setup-node` step in `ci.yml` carries the same rule**, resolved through its own job's `runs-on`: cache on `ubuntu-*` and `blacksmith-*`, and on nothing else. **A label nobody recognizes gets no cache.** That direction is deliberate and the asymmetry is the reason. A missing cache costs one slow install; a cache enabled on the pool costs `actions/setup-node`'s post step tarring a ~12 GB store on a machine every pull request in the estate shares, which arrives as other people's tests timing out rather than as a slow step. A step whose `runs-on` is a fixed hosted label instead sets `cache: pnpm` outright, since there is nothing to resolve.

**`macos-` is absent deliberately.** A hosted `macos-latest` would lose a cache it should have, and that is accepted: nothing here runs on hosted macOS, the self-hosted pool is macOS, and a second pool called something like `macos-pool-1` is the plausible next label. A `macos-` prefix would match it and switch the tar back on, which is the hazard the rule exists to remove. Add it only alongside something that separates a hosted macOS runner from a pool that happens to run macOS. **The trust runs the other way too**: a self-hosted pool named `ubuntu-pool-1` would prefix-match, switch the tar on, and pass every check. Keep a pool label clear of both allowed prefixes.

Two shapes look right and are not. **Testing the runner against the literal `self-hosted`** is correct only while the pool is spelled that way, and the whole purpose of `CI_POSTGRES_RUNNER` and `CI_FRESH_MIGRATE_RUNNER` is to point a job at a differently-named pool. **`runner.environment`** reports `self-hosted` for third-party ephemeral runners too, since they register through GitHub's self-hosted API, so it would drop the cache exactly where it pays.

The chain is written twice per job, once in `runs-on` and once inside `cache`. `runs-on` cannot read `env`, which is the usual explanation and stops one step short: **it can read `needs`**, and every job carrying the rule already has `needs: changes`, so the `changes` job could emit the resolved runner once and both keys could read it. That route is declined rather than unnoticed. It moves where a job runs out of the job and into another job's output, so `runs-on` stops telling you where the job runs and you have to trace an output to find out. The legibility is worth more than the duplicate, which is now cheaply policed.

`ci/cache-rule.test.ts` holds every copy to its own job's `runs-on` by string equality against the one spelling of the rule, and refuses several shapes it cannot see through rather than passing over them: a cache action from any owner, a caching composite action, a local action outside `.github/actions`, a cache key on a step that is not setup-node, a reusable-workflow call. **It does not cover everything.** A `run:` step that tars a store itself, caching inside a `container:`, and a third-party action that caches without saying so in its name are all outside it, and the rule trusts that a label's prefix describes the machine. **A green workflow run proves none of it**: on the pool both the old rule and the current one resolve to no cache, so a run is green whichever is in the file. The test is what checks it, and it does run on every pull request that touches a workflow: `ci-sqlite` runs `pnpm test`, and a workflow edit is not documentation-only, so the `changes` job marks it code. It is a vitest project of its own (`ci-config`, declared in the root `vitest.config.ts`) because it guards repository configuration rather than any package.

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

`test:pg` (and `test:full` through it) boots a throw-away `postgres:17` container per invocation, plus a transaction-mode PgBouncer in front of it on a private per-run network. Container and network names carry the invoking shell's PID, and both ports are assigned by the kernel and read back, so concurrent runs across worktrees cannot clobber each other. Requires Docker (OrbStack / Docker Desktop / compatible daemon).

**The pooler is not optional decoration.** Ten tests cover the transaction-mode deployment shape, where a session-level `SET ROLE` can strand on a shared backend and poison an unrelated later request. They were gated on an environment variable nothing set, so they had never run anywhere: a suite reporting green while a body of tests inside it never executed. They need two independent clients landing on the **same** backend, which `default_pool_size = 1` produces and a plain Postgres cannot, so there is no cheaper fixture that covers the same ground. It costs about a second to boot and a 16 MB image.

CI runs this same script, so the two cannot drift. That is also why the missing-Docker behavior differs by environment: locally the script skips with a `⊘` message, so a contributor without a daemon is not blocked, while under `CI` it fails, because there the container is the only Postgres and a skip would report green having reached no database.

**Why slim by default.** A pre-push hook that runs the full ~1800-test dual-dialect suite invites `--no-verify` bypassing, and a hook that's bypassed isn't a gate. The slim gate gives fast feedback on what you touched; CI's full matrix is the authoritative dual-dialect check.

### A push costs machine time — verify locally first

Every job in `ci.yml` runs on the self-hosted pool, so a push to a pull request costs no hosted minutes. (A merge to `main` can also fire `Server image`, which is hosted and billed; see above.) It is not free: that pool shares one machine with whatever else is running on it, and **a whole matrix fires on every push to a pull request**. Several tests here fail on a fixed time budget when the machine is loaded, so a busy box manufactures failures that look like defects. Three rules follow, all of which come down to making the push the last step rather than the iteration mechanism:

- **Run `pnpm test:full` locally before pushing, not the hook.** It covers both dialects against a throwaway container, so it catches essentially everything CI would. The hook is SQLite-only and scoped to changed files; it has already gone green on a commit whose Postgres job failed.
- **Batch the work.** Several commits in one push cost the same as one. Pushing after each commit multiplies the load by the number of commits for no extra signal.
- **Never re-run CI to see whether a failure repeats.** Reproduce it locally instead. If a failure genuinely looks environmental, say so with the evidence rather than spending another matrix on the question — re-running until green is how a real defect gets waved through.

A `ci.yml` `workflow_dispatch` is cheap and safe to use: the heavy jobs skip on it deliberately, so a manual run costs only the freshness jobs. It is no longer something you owe anyone — those run on the pull request itself. A `Server image` dispatch is the exception and is not cheap; it always runs the full build.

### Test infrastructure owns what it creates

Every machine resource a test or script allocates — a container, a volume, a temp directory, a background process — is released by the same code, in the same place, on every exit path, failure included. The failure mode this exists for is invisible by design: nothing breaks when a resource leaks, so the cost surfaces later as somebody else's slow CI or full disk. `docker rm` on a container that mounted an anonymous volume takes `-v`, or the volume outlives it with nothing left to reference it — that exact miss once leaked several gigabytes a night from this repo's Postgres test scripts. Review criterion: a change that allocates a machine resource states where it is released, and a cleanup path that only runs on success is a leak with extra steps.

## Deploy

`deploy.sh` at the repo root drives deployment against the operator's configured hosts: git pull + build + migrate + service restart. SSH options (`ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`) cap any transient hang at ~45s. Restarts use an atomic kill-and-relaunch so there's no port-handoff race. Service-log rotation runs as a separate per-host scheduled job; details (hostnames, service-manager labels, log-rotator paths) are operator-specific and live outside this repo.

## Error handling

The base error class is `MarfaError` (in `@withmarfa/shared`). All structured errors use it with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Three families of type ship with the platform, all registering into the same runtime registry and all resolving identically:

- **Core** (`packages/types/core/*.json`, 21 types) — the shared vocabulary: life-nouns any app can agree on.
- **Integration** (`packages/types/integrations/*.json`, 16 types) — one vendor's payload shape, so an integration has somewhere faithful to write. `google.*`, `marfa.captured_email`, `marfa.podcast.*`, `raindrop.*`, `readwise.*`, `todoist.task`.
- **System** (`packages/types/core/system/*.json`, 8 types) — platform-internal records, with the restrictions described under System types below.

The split is provenance, not behavior: it exists so a catalog can tell a space which types are the common vocabulary and which exist because a specific upstream service does. The codegen in `packages/types/scripts/generate.ts` emits one array per family into `generated/type-registry.ts`; shared bundles them at build time via tsup's `noExternal`. Schemas marked `_deferred: true` stay on disk as a record of shape but are skipped by the generator and excluded from the runtime registry. Custom types register at runtime via `POST /types` and persist in the `custom_types` table. Platform-shipped types — all three families — cannot be modified or deleted via the API.

**One validator across both authoring paths.** `validateTypeSchema` lives in `@withmarfa/types` and is called by the in-tree codegen and by `POST /types` alike, so an in-tree JSON schema is a valid runtime submission verbatim. Every error it raises carries `field`, `expected`, `actual` and `hint`. See `packages/types/AGENTS.md`.

Inheritance rule: child types may add new fields, and may re-state an inherited field only to sharpen its description or tighten it to required. Changing an inherited field's shape, or loosening a required field, is rejected with `inheritance_violation`.

Types may declare an optional `display_hints: { title_field?, body_field? }` block pointing generic readers at the canonical title/body fields; hints are inherited from the nearest ancestor when a subtype omits them.

Lifecycle is universal — the metadata-layer `state` axis is `active | archived | trashed`. Types do not declare their own state machines; `SYSTEM_TRANSITIONS` in shared is the authoritative graph.

## Edges

Relationships between items are first-class typed edges, not embedded references. Nine core edge types live as JSON under `packages/types/core/edges/` and seed the in-memory registry at startup: `about`, `parent-of`, `in-collection`, `in-thread`, `attached-to`, `references`, `authored-by`, `derived-from`, `supersedes`. Each carries cardinality (`one-to-one` / `one-to-many` / `many-to-one` / `many-to-many`), `cascade_on_delete` (`cascade` / `orphan` / `block`), and source / target type constraints.

A constraint entry is `*`, a type identifier (matched inheritance-aware, so a subtype satisfies an ancestor's entry), or `role:<name>` naming a structural role the endpoint type declares about itself. **Constrain on a role whenever the set of valid endpoints is open.** A list of names admits only the types whoever wrote the edge had already thought of, and nobody outside this repository can add to it — `in-collection` named three platform containers and so left every integration writing its own vocabulary with nothing it was allowed to point at. Roles are a closed set (`container` today) declared per type as `roles: ["container"]` and inherited down the parent chain; both authoring paths refuse an unknown one, because a role nothing defines matches no type and would refuse every endpoint while reading as though it admitted a family of them.

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

**A client's stored scope ceiling catches up to the bundles it asks for.** `auth_oauth_client.scopes` is written once at registration and never refreshed, so on its own it is a snapshot of an allowlist that moves whenever the type registry does, and a client silently ages out of the platform: a type registered after the client was is uncoverable by it forever, while the consent screen goes on offering the scope. Both surfaces that ask a client for scopes widen the stored row to include the bundle scopes a request names, once, lazily, so every existing client self-heals on its next sign-in or device login. The repair is shared (`auth/ceiling-catchup.ts`) rather than restated, because a row two callers widen on two different rules is two rows.

Three bounds on that, each load-bearing. It widens **by what was requested**, not to the whole bundle union, because the ceiling is also what a client gets when it omits `scope`. It admits **only scopes the bundles publish**, so wildcards and the per-type scopes outside the curated set still need the client registered for them. And it **never shrinks**, because a scope for a type that no longer exists is already dropped at request time against the live allowlist, where it costs nothing.

OAuth scope grammar mirrors these: `<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`, `metadata.<subresource>:<verb>`, plus two verb-less families that reach no permission map at all — the OIDC literals and `capability.<surface>`, a closed set naming the administrative surfaces (nothing gates on one yet). Scopes parse via `parseScope` in `@withmarfa/shared`; the consent UI renders both the literal scope and a plain-English description sourced from each type's `description` field in `TYPE_REGISTRY` (with built-in fallbacks for metadata sub-resources). Two sub-resource scopes are enforced: `metadata.types:write` gates `POST /types` and `metadata.edge_types:write` gates `POST /edge-types`, both for non-admin credentials. Admin keys bypass; OAuth tokens project the scopes into the `metadata_permissions` map on the synthetic `ApiKey`.

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
