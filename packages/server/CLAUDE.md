# @mymehq/server

The Hono HTTP server exposing the Myme API. Private package — never published to npm; deployments build from source.

## Layout

- `src/index.ts` — the entry point. Boots storage, blob backend, retention workers (`TrashPurger`, `FeedExpirer`, `VersionThinner`, audit cleanup, event-log cleanup), and the Hono app.
- `src/app.ts` — composes the router from per-route modules; sets up middleware (auth, rate limit, CORS, logging).
- `src/routes/*.ts` — one file per route group: `items.ts`, `types.ts`, `keys.ts`, `tenants.ts`, `users.ts`, `edges.ts`, `search.ts`, `bulk.ts`, etc. Routes use `@hono/zod-openapi`'s `createRoute` so OpenAPI generation falls out for free.
- `src/storage/` — dual-dialect Drizzle layer. `interface.ts` defines `Storage`, `ItemStore`, `KeyStore`, etc.; `pg/` and `sqlite/` are sibling implementations. `connection.ts` carries the bootstrap `SCHEMA_SQL` block (mirrors what migrations would produce on a fresh DB).
- `src/middleware/auth.ts` — bearer-token + OAuth resolution; sets `c.var.apiKey`.
- `src/test-utils.ts` — `createTestContext()` for in-process integration tests across PG/SQLite.

## Schema changes

When changing a column or adding a table:

1. Edit the Drizzle schema (`storage/{pg,sqlite}/schema.ts`).
2. Generate migrations: `pnpm --filter @mymehq/server run migrate:pg:generate` and `migrate:sqlite:generate`.
3. Hand-review the generated SQL — Drizzle Kit sometimes produces DROP+ADD when a careful ALTER+UPDATE+ALTER would be lossless. Edit the SQL by hand if needed.
4. Mirror the change into the `SCHEMA_SQL` bootstrap block in the corresponding `connection.ts`.
5. Update both `_journal.json` files under `drizzle/{pg,sqlite}/meta/` to add the new entry.
6. Run `pnpm test:fresh-sqlite` and `pnpm test:pg` to verify the migration is correctly applied to existing databases AND the bootstrap path produces the same shape.

## Routes

Every new route under `src/routes/` ships with a sibling `*.test.ts` covering at minimum the auth gate and happy path. PR review enforces.

The OpenAPI spec is generated from `createRoute` definitions — never hand-edited. Run `pnpm --silent --filter @mymehq/server generate:openapi > openapi.json` after route changes; the freshness CI job checks for drift.

## Auth helpers (T-051 layered, Wave B Part 2 completeness pass)

Three tiers, picked by intent:

- **`requireAuth(c)`** — bearer token must resolve. No role check.
- **`requireWorkspaceAdmin(c)`** — admits both `admin` (platform) and `workspace_admin` (tenant-bounded). Use for routes that genuinely belong inside a tenant. **The route MUST thread `key.tenant_id` into storage queries** so a workspace_admin attempting to address another tenant's resource gets a 404 (cross-tenant probes never see other tenants' data). With T-025 (Postgres RLS) wired, the DB layer enforces this independently when `MYME_RLS_ENFORCE=true`; the application-layer fence remains load-bearing for self-hosts that leave RLS off.
- **`requireAdmin(c)`** — platform-only. Use for routes that need cross-tenant authority or instance-level ops: tenant CRUD, OAuth client registration, audit cleanup, metrics, archive restore, platform-credential mint.

**Type access bypass.** `checkTypeAccess` and `computeTypeFilter` admit both `admin` and `workspace_admin` without consulting `type_permissions`. workspace_admin is the "admin within tenant" tier — keys deliberately scoped to a subset of types belong as `member` with explicit `type_permissions`, not as workspace_admin. The platform-credential gate on `system.*` / `myme.*` writes still applies (workspace_admin is not platform unless explicitly minted that way).

When auditing a `requireAdmin` callsite for tenant widening: the route is safe to widen iff every storage operation it performs filters by (or stamps from) the caller's `tenant_id`. Lookups via path id MUST go through tenant-scoped store methods (e.g., `get(id, tenant_id)`); list operations MUST pass `tenant_id`; create operations MUST stamp `tenant_id` from the caller. If any of those isn't the case, either leave as `requireAdmin` or add a route-level tenant filter / 404-cloak (the pattern used in `keys.list/revoke/update` here).

Routes widened in T-051 (Wave B Part 1): `POST /keys`, all `/webhooks/*`, `POST /connections/install`, `POST /connections/:id/uninstall`. Routes widened in Wave B Part 2: `GET /keys`, `DELETE /keys/:id`, `PATCH /keys/:id`, `DELETE /items/:id/purge`, plus the new `GET /tenants/me/quotas`. Routes still on `requireAdmin`: `tenants.*` (cross-tenant CRUD by definition), `oauth.client/token`, `audit.cleanup`, `metrics`, `admin-archive`, admin blob ops, and `types.update/delete` + `edge-types.create/delete` (the storage layer for custom types/edge-types loads through an in-memory registry that doesn't currently filter by tenant_id at lookup time — widening these requires a small registry-side audit, filed as follow-on).

## Per-route enforcement order

Most write routes follow the same gate sequence:

1. Resolve auth (`requireAuth(c)`, `requireWorkspaceAdmin(c)`, `requireAdmin(c)`, or — for metadata-layer mutations — `requireMetadataPermission(c, subresource, level)` which admits admin + scope-bearing credentials).
2. Validate body shape (Zod via `createRoute`).
3. Check type permissions (`requireTypeAccess(c, type, "write")`).
4. Resolve enforcement levers (TSC42 §5): tenant config + per-credential override → effective `EnforcementSettings`.
5. Apply source allow-list (reject if violating).
6. Apply strict-mode validation (reject unknown properties when on).
7. Stamp `source`, `origin`, `tier` from credential defaults.
8. Run the storage write inside a transaction.
9. Hydrate the response (edges, metadata) and return.

Read routes apply the source-filter lever in step 4 before issuing the storage query.

## Request context (`c.var`)

Middleware composes shared per-request state on `c.var`. Routes read these directly rather than re-resolving:

- **`apiKey: ApiKey | undefined`** — set by `authMiddleware` from the bearer token. Carries `tenant_id`, `connection_id` (runtime credentials), `source`, role, and the permission maps. `undefined` for anonymous requests.
- **`authType: "api_key" | "oauth" | undefined`** — distinguishes how the bearer was resolved.
- **`clientIp: string | null`** — resolved by `clientIpMiddleware` against `TRUSTED_PROXY_CIDRS`. Threaded into every `audit.log` call (T-027).
- **`requestId: string`** — per-request UUID for log correlation.
- **`cycle: { originatingConnectionId: string | null; hopCount: number }`** — cycle metadata (T-039), resolved by `cycleMiddleware` after auth. Reads `X-Myme-Cycle-Origin` / `X-Myme-Cycle-Hop` (a connector continuing a chain), or falls back to the api key's connection binding (a connector kicking off a chain), or stamps the human sentinel `{ null, 0 }` for ordinary user requests. Routes spread `...c.var.cycle` into every `publish(...)` so the reactive-run bridge can self-suppress and `passesHopBudget` can attribute by origin. **Never `null`** — the sentinel is always present.

Middleware order in `app.ts`: logger → CORS → client-ip → auth → cycle → rate-limit → routes. The cycle resolver depends on auth's `c.var.apiKey`, so it must run after auth.

## Postgres RLS (T-025)

Two coordinated PRs land RLS as defence-in-depth beneath the application-layer tenant scoping.

**Part 1 — schema scaffold.** Migration `0035_rls_application_role.sql` creates the `myme_app` non-owner role, grants CRUD on the eleven tenant-scoped tables (`items`, `edges`, `versions`, `metadata`, `api_keys`, `blobs`, `custom_types`, `custom_edge_types`, `outbound_webhooks`, `audit_log`, `event_log`) plus instance-wide reads on `tenants`/`settings`, and adds per-table RLS policies keyed on `current_setting('myme.tenant_id', true)`. Bootstrap mirror in `pg/connection.ts` applies the same DDL on fresh databases. The metadata + versions tables have no direct `tenant_id` column — their policies join via items. The blobs table uses `tenant_id = ''` instead of NULL because its composite PK requires `tenant_id NOT NULL DEFAULT ''`.

**Part 2 — connection-pool wiring.** Migration `0037_rls_extend_grants.sql` extends GRANTs to the remaining tables `myme_app` needs (`inbound_webhooks`, `inbound_webhook_events`, `connection_oauth_tokens`, `connection_leased_tokens`, `oauth_*`, `users`) plus identity-column sequences. RLS policies on the three direct-tenant_id tables in that list are filed as a follow-on; the application layer remains the load-bearing fence on those.

The Drizzle PG instance is wrapped in a per-request context proxy (`storage/pg/request-context.ts`) that consults an `AsyncLocalStorage` on every method access. The RLS middleware (`middleware/rls-tenant-context.ts`) wraps each tenant-bounded request in `db.transaction(async tx => { SELECT set_config('myme.tenant_id', $1, true); SET LOCAL ROLE myme_app; ... })` and stores `tx` on the ALS. Storage calls during the request flow through `tx`'s reserved connection and are subject to the policies.

**Activation.** Gated by `MYME_RLS_ENFORCE=true`. With the flag unset (the default), the proxy still exists but the middleware never installs an ALS context, so all queries fall through to the unwrapped base instance and run as the connection owner (RLS bypassed by virtue of ownership). Single-tenant self-hosts continue unchanged.

**Bypass paths.** Three intentional carve-outs from the role-switch:

- **Platform-admin / anonymous / bootstrap** — requests with no `apiKey.tenant_id` skip the wrapper and run as the owner. `requireAdmin` is still load-bearing for cross-tenant authority.
- **Better Auth** — `storage.betterAuthDb` is the unwrapped base instance. The auth library manages its own connection context outside the data-plane request middleware; auth tables (`auth_*`) carry no RLS.
- **Streaming responses** — `/events` (SSE) and `/export` (NDJSON archive) hold the response open for arbitrary durations; wrapping them in a transaction would hold a pool connection for the same duration. Bypassed by URL prefix. Both are reads with application-layer tenant scoping; RLS depth-of-defence on those endpoints is a deliberate follow-on.

## Per-tenant quotas (T-052)

Per-tenant resource ceilings are stored in `tenant_quotas` (PK `tenant_id`); missing rows / NULL columns fall back to env defaults (`MYME_DEFAULT_QUOTA_*`). Counts are computed on-demand via `COUNT(*)` on the underlying tables at quota-check time — no eager-increment / reconcile machinery in this PR (the eager path is a follow-on once load measurement justifies the complexity).

`enforceQuota(c, storage, resource, increment)` is the gate. It's a no-op for tenant-less keys (single-tenant self-hosts + platform admin), so the existing instance-wide flow is unaffected. Routes wired in PR T-052: `POST /webhooks` (resource: `webhooks`), `POST /items` (resource: `items`). Blobs / storage_bytes / per-tenant rate-per-minute enforcement is filed as follow-ons; the schema and store carry the columns ready for them.

Admin surface: `GET /tenants/:id/quotas` and `PUT /tenants/:id/quotas` (platform-admin only). Workspace_admin's read-own surface (`GET /tenants/me/quotas`) is a follow-on.

Errors: `quota_exceeded` (HTTP 429) with `details: { resource, limit, current }` so SDK / CLI / operator alerts can wire off the shape.

## Blob storage tenant scoping (T-049)

The `blobs` metadata table has a composite PK on `(tenant_id, hash)`. Different tenants uploading the same hash bytes get separate metadata rows; the storage backend (filesystem / S3) still keys by hash globally so the physical file is shared (content-addressed deduplication preserved). `tenant_id` is `NOT NULL DEFAULT ''` — empty string is the sentinel for instance-wide / single-tenant / platform-admin uploads, used to keep the composite PK clean across both dialects.

`storage.blobs.{register, get, remove}` take an explicit `tenantId` parameter; the route layer threads `key.tenant_id ?? ""` so platform-admin uploads on hosted instances and all uploads on single-tenant self-hosts go to the empty-string row. Cross-tenant probes (`GET /blobs/:hash` from a tenant that hasn't uploaded those bytes) return 404. `storage.blobs.removeAllForHash` exists for the platform-admin orphan-cleanup path that nukes a hash from every tenant.

The storage interface's `listAll` / `count` are unscoped by design — admin reconcile + metrics surfaces only.

## Reserved extension namespaces

The metadata layer's `extensions` map is a free-form JSON sidecar keyed by namespace string. A handful of namespaces are **reserved** with constrained write-access semantics:

- **`connection.runtime`** (workstream 2) — verbose per-Connection runtime state for `system.connection` items of kind `external-service-connector`: sync cursors, in-flight idempotency keys, recent error tail, retry counters. Writable only by the connector's own credential (the one referenced by `credential_ref` on the Connection); readable by tenant admins and the connector. The runtime executor in workstream 3 is the legitimate writer; in workstream 2 the namespace is reserved but no internal code writes it yet.

Reserved namespaces are documented here so accidental general-purpose use ("just stash some stuff") doesn't conflict with platform semantics. Application-defined extensions should use namespaced keys that don't collide with reserved roots.

## Tests

`pnpm test` from the monorepo root, or `pnpm test:fresh-sqlite` / `pnpm test:pg` for the dialect matrices. Integration tests use `createTestContext()` from `src/test-utils.ts` — boots an in-process app against a `:memory:` SQLite or a throw-away `postgres:17` container.
