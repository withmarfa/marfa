# Myme

Typed data layer. This monorepo contains eight active workspace packages plus six in-tree Integrations and the Cloudflare infra package:

**Core packages (`packages/`):**

- **@mymehq/types** — JSON schemas for the core type set plus the validate/generate scripts that emit the TypeScript registries (`ALL_TYPES`, `ALL_EDGE_TYPES`, `ALL_SYSTEM_TYPES`). Consumed by `@mymehq/shared`; private (bundled into shared's dist, not published to npm).
- **@mymehq/shared** — Wire types, Zod validation schemas, error codes, type registry consumer, ID utilities, the OAuth scope grammar parser, the `IntegrationManifestSchema`. The foundation imported by every other package.
- **@mymehq/server** — Hono HTTP server exposing the Myme API (private, not published). Carries the data plane plus the Connections / OAuth / Better Auth surfaces.
- **@mymehq/sdk** — TypeScript HTTP client (`@mymehq/sdk` and the `@mymehq/sdk/auth` subpath for the OAuth helpers — `MymeAuth`, PKCE helpers, token storages, `startDeviceFlow`).
- **@mymehq/webhooks** — Cross-runtime inbound-webhook signature verification (HMAC-SHA256, Slack, Stripe, GitHub). Web Crypto only, so `runtime-control` (Workers) and `server` (Node) consume the same code.
- **@mymehq/runtime-control** — Cloudflare Worker control plane. Verifies inbound webhook receipts, enqueues per-Integration messages, mediates the runtime-credential broker. Web-Crypto only; no Node APIs.
- **@mymehq/runtime-sdk** — In-Worker SDK consumed by Integration Workers. Queue consumer, echo-suppression DO, manifest-typed handler scaffolding.
- **@mymehq/runtime-test** — In-Worker test harness mirroring the runtime-sdk surface so Integrations can run unit tests in a `miniflare`-style fixture without booting a real Cloudflare Workers runtime.

**In-tree Integrations (`integrations/`):** `_template` (the scaffold every contributor copy-pastes), `rss-watcher`, `github-webhooks`, `google-calendar`, `sync` (the file-to-Myme bridge re-presented as a Connection — the agent itself lives in `mymehq/sync`), `task-auto-archive`. Each ships a Zod-canonical `manifest.ts` and a sibling `manifest.test.ts` that parses it through `IntegrationManifestSchema`.

**Infra (`infra/`):** `cloudflare` — `wrangler.jsonc` + deploy script for the runtime-control Worker, the per-Integration Workers, and the shared Queues / KV / Containers bindings.

`@mymehq/shared`, `@mymehq/sdk`, and `@mymehq/webhooks` publish to npm under the `@mymehq` scope via OIDC trusted-publisher (`.github/workflows/publish.yml`), fired on `v*` tag pushes. Other workspace packages are private.

## Tech stack

- TypeScript 6 (strict mode, ESM-only, NodeNext module resolution)
- pnpm workspaces for monorepo management
- Vitest for testing
- Zod for runtime validation
- Hono for HTTP server with `@hono/zod-openapi` for route definitions and OpenAPI spec generation (server package)
- Drizzle ORM with better-sqlite3 and Postgres dual-dialect (server package)

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

Long-lived worktrees that rebase `main` and pick up new workspace packages need a fresh `pnpm install` before they can build. `pnpm install --frozen-lockfile` is a near-instant no-op when the lockfile hash hasn't changed, so the per-package `node_modules/.bin/` symlinks for the newly-added packages never get linked — the first `pnpm run build` then fails with `sh: tsup: command not found` from inside the affected package.

`pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error` to catch this: pnpm compares the `workspacePackagePatterns` recorded in `node_modules/.modules.yaml` against the current workspace set and fast-fails with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` before any script runs. When you see that error, run `pnpm install` (plain — not `--frozen-lockfile`) and retry. Don't bypass with `--no-verify` or by working around the build — the state change is real and the install is the right fix.

## Authentication model

Two layers coexist permanently and don't share credentials:

- **Bearer tokens** (`myme_k1_*` API keys, `myme_at_*` OAuth access tokens) authenticate every API call to `/items`, `/edges`, etc. Hashed-on-storage; resolved by `middleware/auth.ts`.
- **Better Auth session cookies** authenticate the human at the consent screen. The library is mounted at `/auth/*` via `app.on(["POST", "GET"], "/auth/*", ...)` after the explicit `/auth/clients`, `/auth/authorize`, `/auth/token`, `/auth/tokens` routes. Cookie is `HttpOnly + Secure + SameSite=Lax`, scoped to `/auth`. **It does not authenticate the data plane** — `/items` with only the cookie returns 401.

Sign-up is gated by `MYME_AUTH_ALLOW_SIGNUP` (default `false`). Single-user self-hosted instances enable it for the initial admin sign-up only. Better Auth tables (`auth_user`, `auth_session`, `auth_account`, `auth_verification`) are isolated under the `auth_*` prefix and use Drizzle's timestamp-mode columns (Date round-trip), distinct from myme's TEXT-ISO convention elsewhere in the schema.

Email verification is required (Wave C PR2). New accounts sign up successfully but `auth_user.email_verified` starts `false` and `requireEmailVerification: true` blocks sign-in until the user clicks a verification link. The grandfather migration `0042` (PG) / `0035` (SQLite) marks every account created before this PR as verified at deploy time so the flip doesn't lock them out. The verify-email surface lives at `/auth/verify-email`; the sign-up wrapper redirects to it after a successful sign-up.

Sign-in methods land per workstream-1 plan: email + password (PR 1), passkey + magic link (PR 2), generic OIDC client / federated (PR 3), Myme as IdP via OIDC Provider plugin (PR 5).

User-app grants are stored as `system.connection` items with `kind: app`. The OAuth tables `oauth_codes` and `oauth_tokens` reference the item id via `connection_item_id` (FK to `items.id`, ON DELETE CASCADE). The previous standalone `oauth_grants` table is dropped. The same `system.connection` type carries the other two kinds shipped by the Connections build: `integration` (a connected upstream service such as Google Calendar) and `tenant` (a relationship between two tenants).

The OAuth consent endpoints (`GET/POST /auth/authorize`) gate on the better-auth session cookie, not admin bearer tokens. End users sign in via `/auth/sign-in` and approve their own grants; an unauthenticated request to `/auth/authorize` redirects to `/auth/sign-in?return_to=<original-url>`. Admin bearer tokens are still required for `/auth/clients` (client registration) and `/auth/tokens` (token management).

## System types

The reserved `system.*` namespace carries platform-internal items. All `system.*` types use a bounded lifecycle (`active | revoked` only — not the universal three-state). Only platform-flagged credentials (`is_platform: true`) can write `system.*` items; ordinary tenant credentials are rejected at `POST /items`.

- `system.device` — connected devices (name, kind, last-active timestamp).
- `system.credential` — API keys and OAuth tokens (encrypted at rest under per-domain HKDF tags).
- `system.app` — registered app identities. Required before any `app.<app-name>.<type>` references resolve.
- `system.webhook` — outbound webhook subscriptions (URL, secret, event filters, delivery state).
- `system.connection` — approved relationships (the three kinds described under Authentication).
- `system.integration` — published Integration manifests. One row per `(name, version)` pair; the install pipeline persists the manifest onto the `system.connection` it produces.
- `system.activity` — operator-visible state: sync progress, errors, reauth prompts. Severity-tagged. The `severity: action_required` slice surfaces as a Repairs-style inbox.

Only platform-flagged credentials (`is_platform: true`) can write to `system.*`; ordinary tenant credentials are rejected at `POST /items` regardless of `type_permissions`.

## Reserved extension namespaces

The metadata-layer `extensions` map is otherwise free-form, but a handful of namespaces under `connection.*` are reserved with constrained write semantics. The canonical entry is **`connection.runtime`** — verbose per-Connection runtime state for `system.connection` items of kind `integration`: sync cursors, in-flight idempotency keys, recent error tail, retry counters. Writable only by the connection's own runtime credential; readable by tenant admins and the connection. The `packages/server/CLAUDE.md` carries the full list.

## Connections runtime substrate

Three coupled subsystems shipped together as the Connections build (workstreams 1–3):

- **Connection OAuth proxy** — `POST /connections/:id/proxy/*` forwards to the connection's configured upstream URL with `Authorization: Bearer <decrypted access_token>`. Refreshes on 401, single-flight refresh, refresh-token rotation, flips `runtime_status: reauth_required` on terminal failure.
- **Connection leased tokens** — `/connections/:id/lease-tokens` issues short-TTL bearers that an upstream service can use to call back into Myme directly without holding the connection's full credential. Manifest-capability gated.
- **Reactive run bridge + hop budget** — events published via `pubsub.publish` carry cycle-detection metadata (`originating_connection_id`, `hop_count`). The bridge fans out to subscribed connections; events whose `hop_count` exceeds the tenant's `max_event_hop_budget` are dropped and recorded as `system.activity` with `severity: error` so the user surface can show the loop detection. The Cloudflare control plane (`runtime-control`) verifies inbound webhook receipts, enqueues per-Integration Worker messages, and mediates the **runtime-credential broker** that mints a short-lived per-connection key the Worker uses for callbacks. Inbound webhook signature verification (HMAC-SHA256, Slack, Stripe, GitHub) lives in the shared `@mymehq/webhooks` package — Web Crypto only, so both `runtime-control` (Workers) and `packages/server` (Node) consume it without runtime drift.

**Two substrates run integrations.** The Cloudflare path above is the `hosted` substrate. T-173 added the `local` substrate — a Node + pg-boss + `worker_thread` runtime bundled inside `@mymehq/server` for self-hosters who don't want a Cloudflare dependency. The two are exclusive per-deployment via `MYME_INTEGRATION_RUNTIME`; the handler authoring surface (`@mymehq/runtime-sdk`) is identical on both. Component map lives in `packages/server/CLAUDE.md` under "Local integrations runtime"; the operator-facing semantic parity sheet is at `mymehq/docs/concepts/runtime-substrates.mdx`.

For the per-route specifics — including the OAuth bootstrap callback at `/oauth/callback/:provider` and the inbound webhook receipt URL pattern — see `packages/server/CLAUDE.md`.

## Environment variables

Server package (not needed for shared or SDK development):

- `PORT` — server port (default: 8600)
- `STORAGE_DIALECT` — `sqlite` or `pg` (default: sqlite)
- `DATABASE_URL` — Postgres connection string (required when dialect is pg)
- `SQLITE_PATH` — database file path (default: `./data/myme.db`)
- `BLOB_BACKEND` — `filesystem` or `s3` (default: filesystem)
- `BLOB_PATH` — blob storage directory (default: `./data/blobs`)
- `MAX_BLOB_SIZE` — maximum blob upload size in bytes (default: `52428800` / 50MB). Oversized uploads return HTTP 413 `blob_too_large`
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — S3 config
- `S3_ENDPOINT` — custom S3-compatible endpoint (MinIO, R2, etc.); optional
- `CDN_BASE_URL` — public CDN prefix rewritten onto blob URLs in responses; optional
- `API_KEY_SALT` — salt for key hashing (required in production)
- `CORS_ORIGINS` — allowed origins, comma-separated
- `AUTH_MODE` — `keys` (default) or `hosted` (multi-tenant with user accounts)
- `MYME_DEFAULT_QUOTA_ITEMS` / `MYME_DEFAULT_QUOTA_WEBHOOKS` / `MYME_DEFAULT_QUOTA_BLOBS` / `MYME_DEFAULT_QUOTA_STORAGE_BYTES` / `MYME_DEFAULT_QUOTA_RATE_PER_MINUTE` — T-052 default per-tenant ceilings. Unset = unlimited (no enforcement). Per-tenant overrides via `tenant_quotas` rows take precedence. Today `items`, `webhooks`, `blobs`, `storage_bytes`, and `rate_per_minute` enforcement are all wired (T-052 + Wave B Part 2 follow-on).
- `MYME_RLS_ENFORCE` — when `true`, each tenant-bounded request is wrapped in a Drizzle transaction with `SET LOCAL ROLE myme_app` and `set_config('myme.tenant_id', $tenant, true)` so the per-table RLS policies actually filter queries (defense-in-depth beneath the application-layer scoping). **Default `true` from T-146** (was `false` pre-T-146); explicit opt-out is `MYME_RLS_ENFORCE=false`. SQLite is unaffected — the middleware skips when `storage.pgDb` is undefined regardless of this flag. Platform-admin keys (no tenant_id) and anonymous routes bypass the wrapper. Streaming responses (`/events`, `/export`) apply session-level RLS on a dedicated pool connection inside the route itself (T-146; see `storage/pg/streaming-rls.ts`) — they're exempt from the transaction wrapper but not from RLS.
- `RATE_LIMIT_REQUESTS` — requests per minute (default: 1000)
- `RATE_LIMIT_ENABLED` — set to `false` to disable rate limiting entirely (on by default)
- `ENABLE_HSTS` — `true` to add Strict-Transport-Security header (only behind TLS)
- `TRUSTED_PROXY_CIDRS` — comma-separated CIDRs (e.g. `10.0.0.0/8,127.0.0.1/32`) for opt-in `x-forwarded-for` trust. Unset = ignore the header (recommended when no reverse proxy is in front). Malformed CIDRs throw at startup.
- `AUDIT_RETENTION_DAYS` — audit log retention in days (default: 90). Tenant override: `TenantConfig.audit_retention_days` (T-050).
- `AUDIT_CLEANUP_INTERVAL_MS` — audit cleanup interval in ms (default: 86400000)
- `MYME_EVENT_LOG_RETENTION_HOURS` — hours an event_log entry survives before the cleanup job purges it (default: 168 / 7 days). Controls how far back an SSE client's `Last-Event-ID` can reach; older cursors receive a terminal `catchup_too_old` event. Tenant override: `TenantConfig.event_log_retention_hours` (T-050).
- `VERSION_RECENT_DAYS` — version recent window in days (default: 30)
- `VERSION_DAILY_SNAPSHOT_DAYS` — daily thinning window end in days (default: 90)
- `VERSION_WEEKLY_SNAPSHOT_DAYS` — weekly thinning window end in days (default: 365)
- `VERSION_MAX_VERSIONS` — hard cap per item (default: 500)
- `VERSION_THINNING_INTERVAL_MS` — thinning job interval in ms (default: 3600000)
- `TRASH_RETENTION_DAYS` — days a trashed item survives before hard-delete (default: 60; `0` disables). Tenant-scoped overrides via `TenantConfig.trash_retention_days` (T-050) take precedence per tenant; the env default applies to the NULL-tenant bucket and to tenants without an override.
- `TRASH_PURGE_INTERVAL_MS` — trash purge job interval in ms (default: 86400000)
- `AUTH_SESSION_CLEANUP_INTERVAL_MS` — cadence (ms) for the better-auth session cleanup sweep that drops `auth_session` rows past their `expires_at` (default: 3600000 / 1h). Instance-wide, not tenant-scoped — Better Auth owns the TTL.
- `ERROR_WEBHOOK_URL` — webhook URL for 500 error notifications (optional, debounced)
- `MYME_ERROR_WEBHOOK_TIMEOUT_MS` — per-fetch timeout (ms) for error-webhook delivery (default: 5000). Tunable so a slow webhook endpoint can't stall the error path.
- `MYME_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS` — per-account throttle (ms) on cancel-email emission from the deletion-guard middleware; stops a sign-in-attempt flood minting fresh cancel tokens + emails for a pending-deletion account (default: 3600000 / 1h; `0` disables).
- `MYME_AUTH_BASE_URL` — issuer URL the better-auth instance is reached at (e.g. `http://localhost:<PORT>`). Drives cookie domains and the OAuth issuer field on the discovery doc. Defaults to `http://localhost:<PORT>`.
- `MYME_AUTH_ALLOW_SIGNUP` — when `true`, enables the email + password sign-up endpoint at `/auth/sign-up/email`. Default `false` per the workstream-1 sign-up policy. Single-user self-hosted instances flip it on for the initial admin account, then back off.
- `MYME_AUTH_SECRET` — shared secret for cookie signing. Required in production; falls back to a per-process ephemeral secret in dev.
- `MYME_OIDC_PROVIDERS` — JSON array configuring federated sign-in providers (Google, GitHub, Authentik, etc.). Each entry: `{ providerId, clientId, clientSecret, discoveryUrl?, scopes? }`. Surfaces `Sign in with <providerId>` buttons on the sign-in page and exposes `/auth/sign-in/oauth2` + `/auth/oauth2/callback/<providerId>`. Empty array (default) means no federated providers.
- `MYME_EMAIL_BACKEND` — `cloudflare | smtp | none`. Default `none` — email-dependent flows (forgot-password, magic-link, email-verify) return HTTP 503 with `email_transport_not_configured` until an operator picks a backend. The factory at `src/email/index.ts` constructs the transport at boot.
- `MYME_EMAIL_FROM` — visible sender address. Default `Myme <hello@mail.myme.so>`. **For the Cloudflare backend the address MUST end in `@mail.myme.so`** — that's the verified Cloudflare Email sending domain. Apex `myme.so` has no DKIM key. The boot-time `senderDomainCheck` fails loud if this is misconfigured (skipped in `NODE_ENV=test`).
- `MYME_EMAIL_REPLY_TO` — Reply-To header. Optional; recommend a monitored inbox so user replies don't bounce silently.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id (the `myme` org account). Required when `MYME_EMAIL_BACKEND=cloudflare`.
- `CLOUDFLARE_EMAIL_API_TOKEN` — Cloudflare API token with "Send Email" permission on the myme account. Required when `MYME_EMAIL_BACKEND=cloudflare`. Distinct from the broader `CLOUDFLARE_API_TOKEN_MYME` user token — minted as a dedicated send-only token for least-privilege.
- `MYME_SMTP_HOST` / `MYME_SMTP_PORT` / `MYME_SMTP_USER` / `MYME_SMTP_PASS` / `MYME_SMTP_SECURE` — SMTP backend config. Required when `MYME_EMAIL_BACKEND=smtp`. Default port `587`. `MYME_SMTP_SECURE=true` for implicit TLS (port 465); leave unset for STARTTLS on 587.
- `MYME_INTEGRATION_RUNTIME` — `hosted | local`. **Default `local` from T-174** (was `hosted` in T-173). `local` boots the Node + pg-boss + `worker_thread` substrate inside the server process and mounts `POST /runtime/webhook/:connection_id` as the inbound webhook receipt. Requires `STORAGE_DIALECT=pg`; SQLite self-hosts must set this to `hosted` explicitly until they migrate. Hosted Myme deployments + any operator that wants the Cloudflare path sets the env var explicitly to `hosted`. Per-Connection state lives under the `connection.runtime` reserved extension namespace. See `packages/server/src/integrations/local-runtime/` and `mymehq/docs/concepts/runtime-substrates.mdx`.
- `MYME_INTEGRATIONS_ROOT` — absolute path to the `integrations/` directory the local runtime loads `dist/local.js` entries from. Defaults to the in-tree directory resolved from the running bundle; set explicitly when the server runs outside the monorepo (packaged Docker image, etc.).
- `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` — `hosted`-substrate only (T-233). JSON map of `integration_name → Cloudflare Queues producer URL`. Each integration that consumes reactive `item-event` dispatches has its own queue (Cloudflare Queues only allow one consumer per queue; the prior shared-queue shape silently dropped messages addressed to non-consumer integrations). Example: `{"google.calendar":"https://api.cloudflare.com/client/v4/accounts/.../queues/.../messages","mymehq.task-auto-archive":"https://..."}`. Unset → reactive-run bridge disabled. Malformed JSON / empty map → bridge disabled + loud error log. Unmapped integration at fanout → one-time `system.activity action_required` per integration per process lifetime, dispatch skipped.
- `MYME_REACTIVE_RUN_SEND_TIMEOUT_MS` — per-fetch timeout (ms) for the `hosted`-substrate reactive-run bridge's Cloudflare Queues producer call (default: 5000). Tune up for realistic Queues latency. Only relevant when the bridge is wired (`CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` + `CLOUDFLARE_QUEUES_API_TOKEN` set).
- `MYME_RUNTIME_CONTROL_URL` / `MYME_RUNTIME_BROKER_KEY` — `hosted`-substrate only: the Cloudflare runtime-control plane URL and the platform broker key the server presents to mint per-Connection runtime credentials. Read by `routes/connections.ts`; unset on `local`-substrate deployments.

**Cloudflare Email Service setup.** The send domain `mail.myme.so` is onboarded via the Cloudflare dashboard ("Email Service → Sending → Onboard Domain"); CF auto-writes DKIM, SPF, MX, and DMARC records under `cf-bounce.mail.myme.so` to the `myme.so` zone. Domain onboarding is dashboard-only — there's no programmatic API for it as of the public-beta phase. Send-time errors from CF (suppressed recipients, validation failures) surface through structured logs; CF maintains its own internal suppression list, so the server holds no parallel `email_suppressions` state.

## Schema-enforcement levers (TSC42 §5)

Three optional levers live in `TenantConfig.enforcement` (writable via `PUT /tenants/current/config`) plus an optional per-credential `enforcement_override` on `ApiKey`. All three default off; flip on per-type to tighten validation:

- **Strict mode** — `enforcement.strict_mode.types: string[]`. For each listed type, unknown properties on writes are rejected with `INVALID_PROPERTIES` (`code: "unknown_property"`). The base `getZodSchema` flips from `z.looseObject` to `z.strictObject`.
- **Source allow-list** — `enforcement.source_allowlist.{types, sources}`. For each listed type, writes whose credential `source` is not in the allowed sources are rejected with `FORBIDDEN`. Stricter than the credential's own scope.
- **Source filter** — `enforcement.source_filter.{types, sources}`. For each listed type, reads narrow to items whose `source` is in the allowed list. Filter-on-read, not enforcement-on-write — the read API silently omits rows that fail the filter.

Per-credential `enforcement_override` merges over the tenant default — setting `strict_mode` on a credential does not clear the tenant's `source_allowlist`.

## Platform credentials (TSC42 §3/§4)

The `is_platform: boolean` flag on `ApiKey` gates registration and writes of the reserved namespaces (`core.*`, `system.*`, `myme.*`). The seed value lives on the bootstrap admin credential created at server install; only an existing platform credential may mint another. Ordinary tenant admin/member keys default to `is_platform: false` and are rejected when they try to claim reserved namespaces.

## Database migrations

Drizzle migrations under `packages/server/drizzle/{pg,sqlite}/` are the schema source of truth. Inline DDL in `connection.ts` (the `SCHEMA_SQL` block) exists only as the fresh-DB bootstrap path used by tests (`:memory:` SQLite) and new instances; it mirrors what running `pnpm migrate` from `0000` would produce.

When changing schema:

1. Update the Drizzle schema file(s) (`src/storage/pg/schema.ts` or `src/storage/sqlite/schema.ts`).
2. Generate migrations: `pnpm --filter @mymehq/server run migrate:pg:generate` and `migrate:sqlite:generate`.
3. Review the generated SQL in `drizzle/pg/` and `drizzle/sqlite/`.
4. Mirror the change into the bootstrap `SCHEMA_SQL` block in the corresponding `connection.ts` so fresh databases get it without the migrator.
5. Run standalone migration on existing dbs: `pnpm --filter @mymehq/server run migrate`.

FTS5 virtual tables stay inline in `sqlite/connection.ts` because Drizzle Kit can't express them. Don't add other inline DDL.

## OpenAPI

Routes use `@hono/zod-openapi` with request/response schemas. The OpenAPI 3.1 spec is generated from the route definitions — not maintained manually. Run `pnpm --silent --filter @mymehq/server generate:openapi > openapi.json` to update the committed spec. The spec endpoint is available at `GET /openapi.json` on a running server.

When adding or modifying routes, use `createRoute()` with Zod schemas for request params, body, and responses. Streaming endpoints (SSE, NDJSON export) and HTML endpoints (OAuth consent) stay as plain Hono routes.

The `openapi-freshness` CI job regenerates and diffs `openapi.json` on every PR; spec drift fails the build with a clear regen instruction.

## Per-route tests

Every new HTTP route added under `packages/server/src/routes/` should ship with at least one smoke test in a sibling `*.test.ts` file (auth gate + happy path are the minimum). PR review enforces. Pre-existing untested routes are not subject to this rule until they're modified.

## Freshness checks before merging

The `types-freshness`, `openapi-freshness`, and `schema-sql-freshness` CI jobs do not run on pull-request events — only on merges to `main` and manual dispatch. This keeps PR CI cheap. If your PR modifies any of the source files below, you **must** fire the freshness workflow manually against the PR branch and confirm it passes before merging.

**Trigger files** — any change under these paths means you owe a freshness run before merge:

- `packages/types/core/**` — core type and edge-type JSON
- `packages/types/scripts/**` — type-registry generator
- `packages/shared/src/**` — wire schemas, error codes, ID utilities
- `packages/server/src/routes/**` — route definitions that feed the OpenAPI spec
- `packages/server/src/openapi/**` — OpenAPI generator
- `packages/server/drizzle/{pg,sqlite}/**` — Drizzle migrations (drive `SCHEMA_SQL`)
- `packages/server/scripts/generate-schema-sql.ts` — the `SCHEMA_SQL` generator
- Any file touched by `pnpm --filter @mymehq/types generate`, `pnpm --silent --filter @mymehq/server generate:openapi`, or `pnpm --filter @mymehq/server schema-sql:generate`

**Command** — run this from inside the `myme` repo after pushing your PR branch:

```bash
gh workflow run ci.yml --ref <your-branch-name>
gh run watch $(gh run list --workflow=ci.yml --branch=<your-branch-name> --limit=1 --json databaseId --jq '.[0].databaseId')
```

If any of `types-freshness` / `openapi-freshness` / `schema-sql-freshness` fails, regenerate locally (`pnpm --filter @mymehq/types generate`, `pnpm --silent --filter @mymehq/server generate:openapi > openapi.json`, or `pnpm --filter @mymehq/server schema-sql:generate`), commit the delta, and re-run. Only merge once the relevant jobs are green.

**Why this exists.** Freshness jobs catch drift between generated artefacts and source files. They used to run on every PR push and were a major CI cost driver (~$5/month on the `myme` repo alone). Moving them to manual-trigger halves the PR-time bill; this rule is the tripwire that keeps the safety net effective.

## Before pushing

Two validation layers:

- **Pre-push git hook (slim)** — automatic, fast local feedback. Runs `build + typecheck + lint + format:check + test:changed` on every `git push` (build first so cross-package type resolution sees fresh `dist/*.d.ts`). `test:changed` scopes to tests whose files changed against `origin/main`; SQLite-only, target sub-30s. Installed via `git config --local core.hooksPath hooks` which `pnpm install`'s `prepare` step sets automatically. Skippable with `git push --no-verify` for transient infra flake.
- **`ci.yml`** — the authoritative run. The full dual-dialect matrix on every PR, on self-hosted or GitHub-hosted runners (`CI_RUNNER`). This is the gate that decides mergeability — the real workflow on real hardware, not a local approximation.

For a full local check before opening a PR, `pnpm test:full` runs the whole dual-dialect matrix (`build + typecheck + lint + format:check + test:fresh-sqlite + test:pg + smoke:worker-entry`) without a clean install — useful when the slim gate's diff-scoped tests don't reach what you've touched.

Per-target helpers for narrow runs:

- **`pnpm test:changed`** — `vitest run --changed origin/main`. Runs tests for files changed vs main.
- **`pnpm test:related <files…>`** — `vitest run --related …`. Runs tests that depend on the listed source files.
- **`pnpm test`** — full SQLite suite, single run.
- **`pnpm test:fresh-sqlite`** / **`pnpm test:pg`** — single-dialect runs.

`test:pg` (and `test:full` through it) boots a throw-away `postgres:17` container per invocation. Container name + port carry the invoking shell's PID so concurrent runs across worktrees don't clobber each other. Requires Docker (OrbStack / Docker Desktop / compatible daemon); if the daemon isn't reachable, the script skips gracefully with a `⊘` message — GitHub Actions runs the Postgres matrix on every PR, so local Docker is belt-and-braces, not a blocker.

**Why slim by default.** The prior pre-push hook ran the full ~1800-test dual-dialect suite and routinely got bypassed via `--no-verify` — a hook that's bypassed isn't a gate. The slim gate gives fast feedback on what you actually touched; CI's full matrix is the authoritative dual-dialect check.

## Deploy

`deploy.sh` at the repo root drives the deployment workflow against the operator's configured hosts: git pull + build + migrate + service restart. SSH options (`ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`) cap any transient hang at ~45s. Restarts use an atomic kill-and-relaunch so there's no port-handoff race. Service-log rotation is handled by a separate per-host scheduled job; details (hostnames, service-manager labels, log-rotator paths) are operator-specific and live outside this checked-in repo.

## Error handling

The base error class is `MymeError` (in `@mymehq/shared`). All structured errors use this class with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Core types live in `packages/types/core/*.json`. The codegen in `packages/types/scripts/generate.ts` emits `ALL_TYPES` into `generated/type-registry.ts`; shared bundles it at build time via tsup's `noExternal`. Schemas marked `_deferred: true` are retained on disk as a record of shape but skipped by the generator and excluded from the runtime registry — useful for parking a stub between iterations. Custom types can be registered at runtime via `POST /types` (admin only) and are persisted in the `custom_types` table. Core types cannot be modified or deleted via the API.

Inheritance rule: child types may add new fields but cannot redefine fields declared by any ancestor in their parent chain. Enforced on `POST /types`.

Types may declare an optional `display_hints: { title_field?, body_field? }` block that points generic readers at the canonical title/body fields; hints are inherited from the nearest ancestor when a subtype omits them.

Lifecycle is universal — the metadata-layer `state` axis is `active | archived | trashed`. Types do not declare their own state machines; `SYSTEM_TRANSITIONS` in shared is the authoritative graph.

## Edges

Relationships between items are first-class typed edges, not embedded references. Eight core edge types live as JSON under `packages/types/core/edges/` and seed the in-memory registry at startup: `about`, `parent-of`, `in-thread`, `attached-to`, `references`, `authored-by`, `derived-from`, `supersedes`. Each carries cardinality (`one-to-one` / `one-to-many` / `many-to-one` / `many-to-many`), `cascade_on_delete` (`cascade` / `orphan` / `block`), and source / target type constraints.

**Direction is spec-exact.** For `parent-of` source = parent, target = child. For `in-thread` source = member, target = thread. Every consumer (cycle-detection walks, filter SQL, cascade planner) obeys this.

Custom edge types register at runtime via `POST /edges/types` (admin only) and persist in `custom_edge_types`. Core types cannot be redefined. Custom edge types do not inherit.

Atomic writes on `POST /items` accept `edges: { [type]: [target_ids] }`. Edge-only mutations go through `/edges` (create / update-properties-only / delete) or `/items/:id/edges` + `/backrefs` for listings. Single-item reads hydrate edges inline; list reads opt in via `?include=edges`.

Query-language filters use `edge[<type>]=<target_id>` (outbound) and `backref[<type>]=<source_id>` (inbound). Both work on `GET /items` and `/search`.

## Permissions

Credentials carry three permission maps:

- `type_permissions` — `{ "<type_pattern>": "read" | "write" | "none" }`. Pattern supports `*` wildcard and `parent.*` subtree.
- `extension_permissions` — `{ "<namespace>": "read" | "write" }`. Scoped to `/items/:id/extensions/:namespace`.
- `edge_permissions` — `{ "<edge_type>": "read" | "write" }` with `*` wildcard. Enforced via `requireEdgePermission` on `POST /edges`, `PATCH /edges/:id`, `DELETE /edges/:id`, and any `POST /items` carrying an `edges` payload.

Edge mutations dual-gate: the caller needs **both** write on the source item's type AND write on the edge type. Admin keys bypass both.

OAuth scope grammar mirrors these: `<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`, `metadata.<subresource>:<verb>`. Scopes parse via `parseScope` in `@mymehq/shared`; the consent UI renders both the literal scope and a plain-English description sourced from each type's `description` field in `TYPE_REGISTRY` (with built-in fallbacks for metadata sub-resources). Today only `metadata.types:write` is enforced — gates `POST /types` for non-admin credentials. Admin keys bypass; OAuth tokens project the scope into a `metadata_permissions: { types: "write" }` map on the synthetic `ApiKey`.

New keys default to `edge_permissions: {}` — edge access is opt-in; callers must grant explicitly.

`metadata_permissions` is the parallel map for metadata-layer mutations. Keyed by sub-resource (today: `types`); default `{}` for new keys. `requireMetadataPermission(c, "types", "write")` admits admin keys, member keys with `metadata_permissions.types === "write"`, and OAuth tokens whose grant carries `metadata.types:write`.

## Webhooks

Outbound webhooks fire on item events (`item.created`, `item.updated`, `item.deleted`, `item.restored`, `item.state_changed`), metadata changes (`metadata.changed`), and edge lifecycle events (`edge.created`, `edge.deleted`). The `WebhookConsumer` runs one subscription per event family and delivers to registered URLs with HMAC-SHA256 signatures plus exponential-backoff retry.

## Code style

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

### `tenant` vs "space"

The internal code term for an isolated data boundary is **`tenant`** — keep it in code, schemas, DB columns, and the role vocabulary (`tenant_admin`). The user-facing word is **"space"** — use it in product docs and any user-visible copy. Not "instance" (that means a server deployment) and not "workspace" (oversells the team angle — a space is usually one person). The split is deliberate: don't surface `tenant` to users, don't invent a third term in code.

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`
