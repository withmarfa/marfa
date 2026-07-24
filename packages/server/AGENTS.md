# @withmarfa/server

The Hono HTTP server exposing the Marfa API. Private package, never published to npm; deployments build from source.

## Layout

- `src/index.ts` — entry point. Boots storage, blob backend, retention workers (`TrashPurger`, `VersionThinner`, audit cleanup, event-log cleanup, `AuthSessionCleaner`), and the Hono app.
- `src/app.ts` — composes the router from per-route modules; sets up middleware (auth, rate limit, CORS, logging).
- `src/routes/*.ts` — one file per route group: `items.ts`, `types.ts`, `keys.ts`, `tenants.ts`, `users.ts`, `edges.ts`, `search.ts`, `bulk.ts`, etc. Routes use `@hono/zod-openapi`'s `createRoute`, so OpenAPI generation falls out for free.
- `src/storage/` — dual-dialect Drizzle layer. `interface.ts` defines `Storage`, `ItemStore`, `KeyStore`, etc.; `pg/` and `sqlite/` are sibling implementations. `connection.ts` imports the bootstrap `SCHEMA_SQL` from a sibling `schema-sql.generated.ts`, auto-generated from migrations by `scripts/generate-schema-sql.ts`. Never hand-edit the generated file.
- `src/middleware/auth.ts` — bearer-token + OAuth resolution; sets `c.var.apiKey`.
- `src/test-utils.ts` — `createTestContext()` for in-process integration tests across PG/SQLite.
- `src/integrations/local-runtime/` — Node-bundled integrations substrate. Conditional boot via `MARFA_INTEGRATION_RUNTIME=local`; pg-boss drives cron + queue, a `worker_thread` per-integration pool runs handler code, per-Connection state lives under the `connection.runtime` reserved extension namespace. See the dedicated section below.

## Schema changes

When changing a column or adding a table:

1. Edit the Drizzle schema (`storage/{pg,sqlite}/schema.ts`).
2. Generate migrations: `pnpm --filter @withmarfa/server run migrate:pg:generate` and `migrate:sqlite:generate`. Each command refreshes the corresponding `src/storage/<dialect>/schema-sql.generated.ts` automatically as a post-step. The PG one needs Docker running so it can spin up a transient `postgres:17` to dump the schema. **Never hand-edit a `schema-sql.generated.ts` file**; the next regen overwrites it and the `schema-sql-freshness` CI job catches drift.
3. Hand-review the generated SQL under `drizzle/{pg,sqlite}/`. Drizzle Kit sometimes produces DROP+ADD where a careful ALTER+UPDATE+ALTER would be lossless. Edit the SQL by hand if needed, then re-run the regen so `schema-sql.generated.ts` reflects the edit. For multi-statement SQLite migrations, ensure `--> statement-breakpoint` separates each `;` — libsql's migrator silently drops trailing statements without it. The `sqlite-migrations-lint` CI job and the `pnpm --filter @withmarfa/server lint:sqlite-migrations` script enforce this and fail loud if a new migration introduces the regression.
4. Update both `_journal.json` files under `drizzle/{pg,sqlite}/meta/` to add the new entry (Drizzle Kit usually handles this automatically).
5. Run `pnpm test:fresh-sqlite` and `pnpm test:pg` to verify the migration applies correctly to existing databases AND the bootstrap path produces the same shape.

## Routes

Every new route under `src/routes/` ships with a sibling `*.test.ts` covering at minimum the auth gate and happy path. PR review enforces.

The OpenAPI spec is generated from `createRoute` definitions, never hand-edited. Run `pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json` after route changes; the freshness CI job checks for drift.

`src/openapi-published.ts` assembles that spec: it reflects `createApp` once per `AUTH_MODE` and unions the documents, because a route group mounted under one mode only (`userAuthRoutes` today) is invisible to a single-mode reflection. Mode-exclusive operations are marked with `x-marfa-auth-modes` and a matching description note, so a reader can tell whether their own deployment serves the endpoint. Adding a mode to `AppConfig["authMode"]` fails to compile until it is listed in `AUTH_MODE_COVERAGE` there. `src/openapi-published.test.ts` is the guard: it boots every mode and asserts the published spec covers and marks each one.

## Auth helpers

Three tiers, picked by intent:

- **`requireAuth(c)`** — bearer token must resolve. No role check.
- **`requireTenantAdmin(c)`** — admits both `admin` (platform) and `tenant_admin` (tenant-bounded). Use for routes that genuinely belong inside a tenant. **The route MUST thread `key.tenant_id` into storage queries** so a tenant_admin addressing another tenant's resource gets a 404 (cross-tenant probes never see other tenants' data). With Postgres RLS wired, the DB layer enforces this independently when `MARFA_RLS_ENFORCE=true`; the application-layer fence stays load-bearing for self-hosts that leave RLS off.
- **`requireAdmin(c)`** — platform-only. Use for routes needing cross-tenant authority or instance-level ops: tenant CRUD, OAuth client registration, audit cleanup, metrics, archive restore, platform-credential mint. The gate tests the `admin` role **and** the absence of a `tenant_id`: platform authority is authority not confined to a tenant, and `POST /admin/tenants/:id/keys` can mint a tenant-bound `admin` whose reach is deliberately one tenant. A key that passes this gate always has `tenant_id === undefined`, so handlers may rely on that.

**Roles are a lattice.** `admin` > `tenant_admin` > `member`, named explicitly as `ROLE_RANK` / `canGrantRole` in `@withmarfa/shared`. Any route that mints a credential from caller-supplied input must run the requested role through `canGrantRole(callerRole, requestedRole)` — privilege travels sideways or down, never up. `POST /keys` is the enforcing callsite; `POST /admin/tenants/:id/keys` is already platform-gated, so its caller sits at the top of the lattice. Rank is orthogonal to the other two axes: `is_platform` (reserved-namespace writes, gated separately) and tenant binding (inherited from the caller, never chosen by the request body).

**Type access bypass.** `checkTypeAccess` and `computeTypeFilter` admit both `admin` and `tenant_admin` without consulting `type_permissions`. tenant_admin is the "admin within tenant" tier; keys deliberately scoped to a subset of types belong as `member` with explicit `type_permissions`, not as tenant_admin. The platform-credential gate on `system.*` / `marfa.*` writes still applies (tenant_admin is not platform unless explicitly minted that way).

**Widening a `requireAdmin` callsite to tenant scope** is safe iff every storage operation it performs filters by (or stamps from) the caller's `tenant_id`. Lookups via path id MUST go through tenant-scoped store methods (e.g. `get(id, tenant_id)`); list operations MUST pass `tenant_id`; create operations MUST stamp `tenant_id` from the caller. If any of those isn't the case, either leave it `requireAdmin` or add a route-level tenant filter / 404-cloak (the pattern used in `keys.list/revoke/update` here).

Routes scoped to `requireTenantAdmin`: `POST /keys`, all `/webhooks/*`, `POST /connections/install`, `POST /connections/:id/uninstall`, `GET /keys`, `DELETE /keys/:id`, `PATCH /keys/:id`, `DELETE /items/:id/purge`, `GET /tenants/me/quotas`, `GET /tenants/me/config`, `PUT /tenants/me/config`, `GET /audit`, plus the custom edge-type surface `POST /edge-types`, `GET /edge-types`, `DELETE /edge-types/:id`. Routes still on `requireAdmin`: `/admin/*` and `/tenants/{id}/quotas` (cross-tenant CRUD by definition), `oauth.client/token`, `metrics`, `admin-archive`, admin blob ops, and `types.update/delete` (the storage layer for custom _item_ types loads through a global in-memory registry that doesn't filter by tenant_id at lookup time; widening those needs the same registry-side audit the edge-type path now has).

`/tenants/me/config` and `GET /audit` are tenant-bounded because every storage call they make is keyed on the caller's own `tenant_id`. `GET /metrics` is not, and stays platform-only: four of its five counters (blobs, keys, webhooks, custom types) are instance-wide, so a partially-scoped response would still report other tenants' totals.

**Bulk writes gate per item/edge, not by role.** `POST /items/bulk` and `POST /edges/bulk` are `requireAuth` plus the same per-resource gate as their single-item counterparts: `POST /items/bulk` runs `requireTypeAccess(type, "write")` for every item; `POST /edges/bulk` runs `requireTypeAccess(source.type, "write")` + `requireEdgePermission(edge_type, "write")` for every edge. admin / tenant_admin bypass the permission maps; a member writes only the types/edges it holds. Tenant scoping is threaded through every storage call (`items.{findBySourceId,get,update,create}`, `edges.{findByTriplesBatch,updateProperties,createRaw}`, all with `tenant_id`), so a tenant-scoped caller can only bulk-operate inside its own tenant. Cross-tenant item ids surface a clean `conflict` (the `items` PK is `id` alone, so a cross-tenant id collision is trapped at create and 404/no-ops rather than 500-ing or updating across tenants), and cross-tenant edge triples are invisible to the upsert lookup. Atomic batches authorize every entry up-front, so an unauthorized item/edge aborts before any write lands. `POST /items/bulk-actions` purge stays `requireAdmin`; every other bulk-action narrows non-admins via `getTypeFilter`.

**Platform-scoped catalog reads.** Some `system.*` types are registered by platform credentials (`is_platform: true`) and live with `tenant_id IS NULL` — `system.integration` is the canonical example today. Tenant members must still read them (the catalog is a marketplace surface), so the reads opt in to the widening:

- For **list reads**, set `ItemFilters.includePlatformScoped: true` on `items.list({...})`.
- For **single-id reads**, pass `{ includePlatformScoped: true }` as the third arg to `items.get(id, tenantId, ...)`.

The widening flips the WHERE clause from `tenant_id = $tenantId` to `(tenant_id = $tenantId OR tenant_id IS NULL)`. The default keeps the strict-equality fence; never widen by default, or null-tenant rows from any source could leak across tenant boundaries. Always pair the widening with a type check on the result (`item?.type === "system.<expected>"`) as the authoritative gate: the type filter is the safety net, the widening is just the lookup mechanic. The four call sites today: `GET /integrations/:id`, `GET /integrations/:id/install`, `POST /integrations/:id/install`, `POST /connections/install` (the admin install path).

**Tenant-scoped lookups must stay fenced.** The inverse holds for tenant-scoped items (every `system.connection`, `system.credential`, `system.activity`, `system.webhook`, plus all `core.*` and user-defined types): when a route has a known-good `tenant_id` in hand from an upstream lookup or a server-signed envelope, **thread that `tenant_id` into every downstream `items.get` call**. The fence on the upstream call is not transitive; each individual lookup needs its own belt. A bare `items.get(id)` against a tenant-scoped type silently widens to "any tenant", which is rarely the intent.

## Per-route enforcement order

Most write routes follow the same gate sequence:

1. Resolve auth (`requireAuth(c)`, `requireTenantAdmin(c)`, `requireAdmin(c)`, or — for metadata-layer mutations — `requireMetadataPermission(c, subresource, level)`, which admits admin + scope-bearing credentials).
2. Validate body shape (Zod via `createRoute`).
3. Check type permissions (`requireTypeAccess(c, type, "write")`).
4. Resolve enforcement levers (strict mode, source allow-list, source filter): tenant config + per-credential override → effective `EnforcementSettings`.
5. Apply source allow-list (reject if violating).
6. Apply strict-mode validation (reject unknown properties when on).
7. Stamp `source`, `tier` from credential defaults.
8. Run the storage write inside a transaction.
9. Hydrate the response (edges, metadata) and return.

Read routes apply the source-filter lever in step 4 before issuing the storage query.

## Request context (`c.var`)

Middleware composes shared per-request state on `c.var`. Routes read these directly rather than re-resolving:

- **`apiKey: ApiKey | undefined`** — set by `authMiddleware` from the bearer token. Carries `tenant_id`, `connection_id` (runtime credentials), `source`, role, and the permission maps. `undefined` for anonymous requests.
- **`authType: "api_key" | "oauth" | undefined`** — how the bearer was resolved.
- **`clientIp: string | null`** — resolved by `clientIpMiddleware` against `TRUSTED_PROXY_CIDRS`. Threaded into every `audit.log` call.
- **`requestId: string`** — per-request UUID for log correlation.
- **`cycle: { originatingConnectionId: string | null; hopCount: number }`** — cycle-detection metadata resolved by `cycleMiddleware` after auth. Reads `X-Marfa-Cycle-Origin` / `X-Marfa-Cycle-Hop` (a connector continuing a chain), or falls back to the api key's connection binding (a connector kicking off a chain), or stamps the human sentinel `{ null, 0 }` for ordinary user requests. Routes do NOT spread `...c.var.cycle` into `publish(...)`. The resolved cycle is written to `cycleRequestContext` (AsyncLocalStorage at `src/cycle-context.ts`) alongside `c.var.cycle`; `pubsub.publish` and `pubsub.publishEdge` read it automatically. `c.var.cycle` stays exposed for diagnostic reads only. **Never `null`**: the sentinel is always present.

Middleware order in `app.ts`: logger → CORS → client-ip → auth → cycle → rate-limit → routes. The cycle resolver depends on auth's `c.var.apiKey`, so it must run after auth.

## Cycle metadata propagation

State that must stay coherent across a request flows through one mechanism (middleware + AsyncLocalStorage), not by every caller spreading the value. `cycleMiddleware` resolves the per-request cycle and writes it to both `c.var.cycle` (diagnostic) and `cycleRequestContext` (the ALS at `src/cycle-context.ts`). `pubsub.publish` and `pubsub.publishEdge` consult the ALS automatically; route handlers do not carry `...c.var.cycle` on every publish call.

**Explicit override path.** Server-internal callers needing to synthesize a cycle (rather than propagate the request's) can pass `originatingConnectionId` and/or `hopCount` explicitly on the `publish` event argument; the resolver short-circuits to the explicit values when either field is present. No internal caller exercises this today; the `POST /connections/preview-event` route runs its own duplicate of `passesHopBudget`'s effective-hop logic against `body.cycle` for hypothetical-event reasoning (it never calls `publish`).

**Outside-request fallback.** When the ALS is empty AND no explicit override is supplied (e.g. the reactive-run bridge's `stop()` sentinel publish), the resolver falls through to `{ originatingConnectionId: null, hopCount: 0 }`, the human-sentinel shape that bypasses the budget.

**Wire-tampering defense preserved.** The `Math.max(hopCount, 1)` floor inside `passesHopBudget` (and its duplicate in `POST /connections/preview-event`) is kept. It defends against malformed inbound `X-Marfa-Cycle-Hop` headers (origin set but `hopCount: 0`): the ALS refactor removes the contributor-discipline failure mode but not the wire-tampering one.

## Postgres RLS

RLS lands as defense-in-depth beneath the application-layer tenant scoping, across four migration parts.

**Part 1 — schema scaffold.** Migration `0035_rls_application_role.sql` creates the `marfa_app` non-owner role, grants CRUD on the eleven tenant-scoped tables (`items`, `edges`, `versions`, `metadata`, `api_keys`, `blobs`, `custom_types`, `custom_edge_types`, `outbound_webhooks`, `audit_log`, `event_log`) plus instance-wide reads on `tenants`/`settings`, and adds per-table RLS policies keyed on `current_setting('marfa.tenant_id', true)`. The bootstrap mirror in `pg/connection.ts` applies the same DDL on fresh databases. `metadata` + `versions` have no direct `tenant_id` column, so their policies join via items. `blobs` uses `tenant_id = ''` instead of NULL because its composite PK requires `tenant_id NOT NULL DEFAULT ''`.

**Part 2 — connection-pool wiring.** Migration `0037_rls_extend_grants.sql` extends GRANTs to the remaining tables `marfa_app` needs (`inbound_webhooks`, `inbound_webhook_events`, `connection_oauth_tokens`, `connection_leased_tokens`, `oauth_*`, `users`) plus identity-column sequences.

**Part 3 — direct-tenant_id policies.** Migration `0040_rls_extend_policies.sql` extends per-table RLS policies to the three direct-`tenant_id` tables that got GRANTs in Part 2 but no policies (`inbound_webhooks`, `connection_oauth_tokens`, `connection_leased_tokens`). Same equality-on-`current_setting` + NULL-allowance shape as Part 1's eleven tables.

**Part 4 — remaining granted-but-ungated tables.** Migration `0067_rls_ungated_tables.sql` closes the gap on the last four `marfa_app`-granted tables that carried tenant data but had no policy: `users` + `tenant_quotas` (direct `tenant_id`, same equality + NULL-allowance shape) and `outbound_webhook_deliveries` + `inbound_webhook_events` (no `tenant_id` column; their policies `EXISTS`-join to the parent webhook on `webhook_id` / `inbound_webhook_id`, deferring the tenant match to the parent's policy). **Plain `ENABLE`, never `FORCE`** — load-bearing on `users`: the Better Auth sign-up provisioning hook (`auth/instance.ts` `databaseHooks.user.create.after`) inserts the new `users` row on the unwrapped owner connection, and the bearer middleware projects an OAuth principal's role via `users.getByAuthUserId` before the per-request RLS transaction wrapper is installed (also owner connection). Both carry no `marfa.tenant_id` GUC; `FORCE` would policy-check them against an empty GUC and fail, stranding every new sign-up. Plain `ENABLE` keeps the owner RLS-exempt. Two tables are deliberately EXCLUDED: `oauth_device_codes` (its only tenant link, `connection_item_id`, is NULL pre-consent, so an items-join policy would hide pending device codes and break the device flow) and `rate_limit_windows` (no tenant column; accessed pre-RLS on the owner connection). The regression guard is `storage/pg/rls-ungated-tables.test.ts`.

**Part 5 — the `tenants` table.** Migration `0068_rls_tenants_table.sql` fences the last row-per-tenant table. `tenants` was granted full CRUD to `marfa_app` in 0035 under the "instance-wide read paths" carve-out and never got a policy, so an unscoped query under the role could read or write every tenant's name, owner email, and status. The tenant key is the primary key itself, so the policy is a plain equality on `id` with no NULL-allowance (`id` is NOT NULL). Every legitimate reader is unaffected: own-tenant `getConfig` lookups match the equality, and the platform-admin routes, the tenant-suspension middleware, the retention fan-out, and Better Auth sign-up provisioning all run on the RLS-exempt owner connection. Plain `ENABLE`, never `FORCE`, for the same owner-exemption reason as Part 4. `settings` stays deliberately unpoliced — it is genuinely instance-scoped config with no tenant key to filter on. Regression guard: `storage/pg/rls-tenants-table.test.ts`.

The Drizzle PG instance is wrapped in a per-request context proxy (`storage/pg/request-context.ts`) that consults an `AsyncLocalStorage` on every method access. The RLS middleware (`middleware/rls-tenant-context.ts`) wraps each tenant-bounded request in `db.transaction(async tx => { SELECT set_config('marfa.tenant_id', $1, true); SET LOCAL ROLE marfa_app; ... })` and stores `tx` on the ALS. Storage calls during the request flow through `tx`'s reserved connection and are subject to the policies.

**Activation.** Gated by `MARFA_RLS_ENFORCE` (**defaults to `true`**). Explicit opt-out is `MARFA_RLS_ENFORCE=false`, convenient for diagnosis but not for production. With the flag off, the proxy still exists but the middleware never installs an ALS context, so all queries fall through to the unwrapped base instance and run as the connection owner (RLS bypassed by ownership). SQLite is unaffected; the middleware skips when `storage.pgDb` is undefined.

**Bypass paths.** Two intentional carve-outs from the role-switch wrapper:

- **Platform-admin / anonymous / bootstrap** — requests with no `apiKey.tenant_id` skip the wrapper and run as the owner. `requireAdmin` stays load-bearing for cross-tenant authority.
- **Better Auth** — `storage.betterAuthDb` is the unwrapped base instance. The auth library manages its own connection context outside the data-plane request middleware; auth tables (`auth_*`) carry no RLS.

Streaming responses (`/events` SSE + `/export` NDJSON / archive) are a special case: wrapping them in a transaction would pin a pool connection for the response's full duration. They are exempt from the transaction wrapper but apply session-level RLS internally (see next section).

## Streaming RLS

`/events` and `/export` apply database-layer RLS through a different mechanism than the request middleware. They cannot wrap themselves in a transaction (long-lived txns wedge pool slots, accumulate locks, risk deadlocks), so each stream reserves a dedicated pool connection and applies **session-level** `SET ROLE marfa_app` + `set_config('marfa.tenant_id', $1, false)` (third arg `false` = NOT `SET LOCAL`). Storage reads inside the stream flow through that connection via the existing `pgRequestContext` ALS proxy: Drizzle bound to the reserved connection becomes the `tx` substitute.

The helper lives at `storage/pg/streaming-rls.ts`. Public surface: `acquireStreamRls(client, tenantId) -> StreamRlsContext` and `withStreamRls(client, tenantId, fn)`. The context carries `release()`, idempotent cleanup that runs a **scoped reset** (`RESET ROLE` plus clearing the `marfa.tenant_id` GUC via `set_config('marfa.tenant_id', '', false)`) on the connection, then returns it to the pool. If the reset fails the connection is destroyed via `reserved.end()` instead: a reset failure means the connection is in an unknown state, and a connection returned to the pool with `marfa_app` role + a leaked `marfa.tenant_id` would be served to a future request as that tenant. The destroy fallback is the load-bearing safety property.

**Why scoped reset, not `DISCARD ALL`.** The cleanup invariant is "no leaked tenant context on connection return to pool", narrower than what `DISCARD ALL` does. `DISCARD ALL` also drops every prepared statement on the session, but postgres.js caches statement names client-side per `Sql` instance and reuses them across reservations of the same underlying connection. Nuking the server side without a client-side invalidation hook surfaced as `prepared statement "<name>" does not exist` 500s on the next request that touched the recycled connection (~20% POST /items failure rate under concurrent SSE + writes). RLS policies read `current_setting('marfa.tenant_id')` at execute time, not bind time, so prepared statements compiled under one tenant's GUC execute safely once the GUC flips: the cache is value-agnostic, and the scoped reset matches the actual invariant precisely.

**Cleanup invariants:**

- `release()` is idempotent — safe to call from multiple exit paths.
- `/export` wires cleanup in a `try/finally` around the start callback's body (single linear path).
- `/events` wires cleanup into the existing `cleanup()` closure, which fires from (a) pump completion, (b) replay errors, (c) the `catchup_too_old` terminal path, (d) the `c.req.raw.signal` abort listener on client disconnect. Acquisition failure aborts the stream cleanly via `controller.error`; no rows ever sent.
- If the scoped reset fails the connection is destroyed via `reserved.end()` rather than returned poisoned.

**Pool-slot consumption.** Each active stream consumes one pool slot for its lifetime. Today's pool size is 10 (`pg/connection.ts`); the bottleneck only bites at 10+ concurrent streams per server instance. Watch in staging; if it bites, partition into a dedicated streaming sub-pool.

**Activation conditions.** All three must hold for the stream to acquire an RLS context:

- `options.rlsEnforce === true` (env-driven; default on).
- `options.pgClient !== null` (PG dialect; SQLite passes `null`).
- Caller has a tenant_id (tenant_admin / member, not platform-admin / anonymous / single-tenant self-host).

If any condition is false the route runs on the owner connection, matching the per-request middleware's bypass semantics.

**Transaction-wrapper exemption.** `STREAMING_PATH_PREFIXES` in `middleware/rls-tenant-context.ts` exempts `/events` + `/export` from the per-request transaction wrapper. They apply session-level RLS internally (above) instead.

## Per-tenant background cleanup

Three cleanup jobs (`TrashPurger`, audit cleanup, event-log cleanup) fan out per-tenant. Each tick the job lists every tenant via `TenantStore.list()`, resolves the effective retention (per-tenant `TenantConfig` override OR env default), and runs the cleanup once per tenant scope plus once for the NULL-tenant bucket (single-tenant self-host items + any rows with no tenant scope).

Per-tenant overrides on `TenantConfig`:

- `audit_retention_days` — overrides `AUDIT_RETENTION_DAYS`.
- `event_log_retention_hours` — overrides `MARFA_EVENT_LOG_RETENTION_HOURS`.
- `trash_retention_days` — overrides `TRASH_RETENTION_DAYS`.

`0` disables the job for that tenant, matching the env-default semantics for `TRASH_RETENTION_DAYS=0`. Negatives are rejected at write.

Coordination locks are keyed per-tenant (`<jobName>:<tenant-id>`, plus `<jobName>:_no_tenant` for the NULL bucket) so multi-instance deployments don't double-process a single tenant. Cost is O(tenants) per cleanup tick; cleanup is off the request hot path, so the unbounded scan is acceptable at our target scale.

The `runTenantCleanup` helper in `storage/retention.ts` is the shared fan-out runner; `TrashPurger.runOnce` accepts an optional `TenantFanout` config that wires the same fan-out semantics for the items-table job.

## Auth session cleanup

`AuthSessionCleaner` in `storage/retention.ts` drops `auth_session` rows past their `expires_at`. **Instance-wide, not tenant-scoped** — the table carries no `tenant_id` column, the deletion criterion is purely time-based, and Better Auth itself owns the session TTL. Cluster-wide coordination lock keyed `"auth-session-cleanup"`. Cadence via `AUTH_SESSION_CLEANUP_INTERVAL_MS` (default 1h). Logs only on non-zero deletes.

## OAuth scope grammar enforcement

OAuth tokens are issued with scopes parsed by `parseScope` in `@withmarfa/shared`. At token-resolve time the auth middleware projects them into the synthetic `ApiKey`'s `type_permissions`, `edge_permissions`, and `metadata_permissions` maps. From there the data plane gates flow through the same helpers used for ordinary API keys:

- **`requireTypeAccess(c, type, level)`** — consults `type_permissions`. Wired on every single-item GET / PATCH / DELETE / restore / transition / version, on every `POST /items` (against `body.type`), and on edge-source and edge-target writes (`POST /items` with `edges`). Admin and tenant_admin bypass; member + OAuth-derived synthetic keys must match the projected permission. List reads use `getTypeFilter` instead (below).
- **`requireEdgePermission(c, edgeType, level)`** — consults `edge_permissions`. Wired on `POST /edges`, `PATCH /edges/:id`, `DELETE /edges/:id`, and every edge mutation inside an atomic `POST /items`. Admin and tenant_admin bypass.
- **`requireMetadataPermission(c, subresource, level)`** — consults `metadata_permissions`. Wired on `POST /types` (`metadata.types:write`). Admin and tenant_admin bypass.
- **List-read enforcement via `getTypeFilter`** — list endpoints (`GET /items`, `/search`, `/export`, bulk reads) project `type_permissions` into a storage-layer `allowed_types` filter. Out-of-scope types silently drop from the result set (status 200 with empty data): implicit denial, not 403. The single-item GET path enforces explicitly via `requireTypeAccess`. Strict rejection on list-filter mismatch would force callers to know exactly what's in scope; implicit denial lets a token pass `?type=X` even with a multi-type scope and get the right results.
- **Empty `allowed_types` filters to zero rows.** The storage layer treats `allowed_types: []` as "no readable types" (forces `1=0` in SQL). Passing it through unfiltered would return every row, a gap a no-scope token could exploit, so the empty case must deny, not widen.
- **More-restrictive-wins is automatic.** OAuth tokens are synthetic `ApiKey` records built only from the granted scopes; there's no underlying API key whose permissions might be wider. Scope and credential are the same map.

## OAuth Provider plugin

The OAuth-protocol surface is owned by the [@better-auth/oauth-provider](https://www.better-auth.com/docs/plugins/oauth-provider) plugin mounted on the better-auth instance. Endpoints land under `/auth/oauth2/*` via the basePath catch-all. The plugin's own tables (`auth_oauth_client`, `auth_oauth_access_token`, `auth_oauth_refresh_token`, `auth_oauth_consent`) replace the dropped `oauth_clients` / `oauth_tokens` / `oauth_codes`.

**Plugin endpoints (via Better Auth basePath `/auth`):**

| Endpoint                                                    | RFC / spec                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /auth/oauth2/authorize` + `POST /auth/oauth2/consent` | Authorization Code + PKCE S256, public clients (no secret)                              |
| `POST /auth/oauth2/token`                                   | `authorization_code`, `refresh_token`, `client_credentials` — refresh rotation built in |
| `POST /auth/oauth2/userinfo`                                | OIDC userinfo                                                                           |
| `POST /auth/oauth2/revoke`                                  | RFC 7009                                                                                |
| `POST /auth/oauth2/introspect`                              | RFC 7662 — new for Marfa                                                                |
| `POST /auth/oauth2/register`                                | RFC 7591 DCR (public — `allowUnauthenticatedClientRegistration: true`)                  |
| `GET /.well-known/oauth-authorization-server`               | RFC 8414 (re-published at root via plugin's exportable helper)                          |
| `GET /.well-known/openid-configuration`                     | OIDC discovery (re-published at root via plugin's exportable helper)                    |
| `GET /auth/jwks`                                            | JWKS for id_token verification                                                          |

**Marfa-owned surfaces (kept):**

- `GET /auth/authorize` — Hono consent route in `routes/auth-consent.ts`. The plugin's `consentPage` config redirects here; the route reads `client_id` + `scope` + `code` from query, fetches prior consent for the re-consent diff, renders via the existing `renderConsentScreen`. Form POSTs back to the plugin's `/auth/oauth2/consent`.
- `/auth/device*` — device-flow state machine over the kept `oauth_device_codes` table. The terminal token-issuance step (`POST /auth/device/token`) writes into the plugin's `auth_oauth_access_token` + `auth_oauth_refresh_token` so the bearer middleware resolves device-flow tokens uniformly with code-flow tokens. See `routes/auth-pages.ts` (kept) for the wiring.
- `/auth/security` + `/auth/grants/*` + `/auth/sessions/*` — user-facing operational surfaces, re-pointed to read from the plugin's tables via `storage.oauthProvider`.

**Bearer middleware (`middleware/auth.ts`):** OAuth-prefix tokens (`marfa_at_*`) resolve via `storage.oauthProvider.validateAccessToken(hashApiKey(token, salt))`. The plugin's `storeTokens.hash` is wired to the same HMAC-SHA256 hash function, so the middleware looks up `auth_oauth_access_token.token` directly by hash. Per-request scopes project through the unchanged `scopesToTypePermissions` / `scopesToEdgePermissions` / `scopesToMetadataPermissions` / `scopesToOidcScopes` from `@withmarfa/shared`. Opaque tokens carry no embedded claims (claims only ride JWT access tokens, which Marfa doesn't issue); the side-channel join (`auth_oauth_access_token.referenceId` → tenant_id, `clientId`+`userId` → `system.connection`) is the correct path for our profile.

**Token tenant binding (`postLogin.consentReferenceId`).** Two parallel hooks bind the plugin's tables to Marfa's tenant model. `clientReference` is called at CLIENT-REGISTRATION time and writes `auth_oauth_client.reference_id` (immutable for the life of the client). `postLogin.consentReferenceId` is called at TOKEN-ISSUANCE time and writes `auth_oauth_access_token.reference_id` for every minted token. Both resolve via `resolveTenantIdForAuthUser(storage, user.id)`, same path. Without the `postLogin` block, every issued token would land with `reference_id=NULL` and the bearer middleware would surface them as `tenant_id=undefined` (keys-mode behavior; multi-tenant scoping broken). The `postLogin` config also requires `page` + `shouldRedirect` (the plugin's optional multi-account-selection UX); Marfa is single-account-per-session, so `shouldRedirect: () => false` makes the page a no-op.

**Discovery doc issuer field (RFC 8414 §3, partial deviation, documented).** The bare-root `/.well-known/oauth-authorization-server` + `/.well-known/openid-configuration` paths re-publish the plugin's metadata at the apex, but the `issuer` field they return is `<baseURL>/auth` (the basePath of the better-auth catch-all), not `<baseURL>`. Strict RFC 8414 readers expect `issuer` to match the discovery URL's host (no basePath). Practical impact is bounded: id_token `iss` claims match the discovery doc's `issuer` value, so token-signature validation by RPs works correctly. The discrepancy only bites strict-RFC validators comparing the discovery URL string against the issuer string. A full fix requires reorganizing the Better Auth basePath from `/auth` to `/`, touching every route + sign-in / sign-up / consent surface. Tracked as a known limitation; revisit if/when a strict-validating RP needs to integrate.

**Grant projection.** A sibling shell plugin (`buildOauthProjectionPlugin` in `auth/oauth-provider.ts`) hosts hooks for `/oauth2/consent`, `/oauth2/token`, `/oauth2/revoke`, `/oauth2/end-session`. Consent-side projection writes (first-time consent) OR updates (re-consent — refreshes `scopes` + `granted_at` on the existing row) the `system.connection { kind: "app" }` item, in the explicit `POST /auth/authorize/decision` route. Revoke-side projection currently log-and-no-ops; the user-facing `/auth/grants/:id/revoke` handler is the actual cascade path (calls `storage.oauthProvider.revokeTokensForGrant(clientId, userId)`).

**`last_used_at` stamping (code-flow).** The bearer middleware resolves the projected `system.connection` item by `(tenantId, clientId, authUserId)` via `storage.oauthProvider.findGrantItemId` on the first authenticated request inside the debounce window, then stamps `properties.last_used_at` via the existing `storage.oauth.updateLastUsedAt` helper. Two-layer debounce (in-memory cache + DB-side conditional UPDATE) means at most one stamp per grant per 30s window cluster-wide. Device-flow grants continue to stamp at `/auth/device/token` issuance against `row.connection_item_id` (the FK on `oauth_device_codes`).

**Refresh-token replay, closed.** Plugin behavior verified in source (`@better-auth/oauth-provider@1.6.13`): stale-refresh replay deletes the entire refresh chain for `(clientId, userId)` and returns `invalid_grant`. The plugin does NOT delete access tokens from the same chain; on their own they would remain valid until TTL (1h default). Marfa closes that gap with a before-hook on `/oauth2/token` (`detectAndZapReplayedAccessTokens`): it hashes the request's `refresh_token`, peeks at the row, and if `revoked: true` pre-emptively deletes access tokens for `(clientId, userId)` via `storage.oauthProvider.revokeAccessTokensForGrant`. The plugin's own logic then runs (returning `invalid_grant`); access tokens are already gone. Best-effort throughout: failures swallowed, the 1h TTL still bounds exposure in the unlikely degraded path.

**JWT plugin (`auth_jwks` table).** Mounted alongside oauth-provider for id_token signing. Auto-generates an RSA key pair on first use; rotates by inserting new rows.

**Scope grammar.** The plugin's `scopes` allowlist is enumerated from `TYPE_REGISTRY.keys()` + `EDGE_TYPE_REGISTRY.keys()` at instance construction (`auth/oauth-provider.ts` → `buildAllowedScopes`). Custom types registered at runtime via `POST /types` are NOT picked up until server restart, an acceptable tradeoff; the plugin's scope-allowlist is static.

## FTS dialect parity

Both dialects index the same set of property fields and respect the same per-type opt-out. The dialect-agnostic helper `extractSearchableText` in `storage/search-text.ts` is the single source of truth for "what text contributes to FTS for this item."

- **SQLite** uses an FTS5 virtual table (`items_fts`) populated at write time by `SqliteSearchStore.indexSync` / `removeSync`. Five columns: `title`, `body`, `description`, `name`, `extra`. The `extra` column concatenates every other string-typed field declared on the type that isn't `searchable: false`.
- **Postgres** uses a materialized `tsvector` column (`items.search_vector`) populated at write time by `PgSearchStore.index` / `remove` via the same shared text extractor. The column is GIN-indexed (`idx_items_search_vector`); the search query reads the column directly instead of computing `to_tsvector(...)` at query time over the JSON.

`searchable: false` on a type's `FieldDefinition` opts the field out of FTS for both dialects. The flag is honored for the four core fields (title, body, description, name) via `isFieldSearchableExcluded` and for the long tail via `getSearchableStringFields`. Defaults to `true` (searchable): a type that omits the flag indexes the field.

`PgSearchStore` writes go through the request-context-aware Drizzle instance (the `db.execute` tagged-`sql` path), so an `index()` call inside a `db.transaction(...)` runs on the same reserved connection as the parent INSERT/UPDATE, preserving atomicity. Reads (the search query) use the bare client; search isn't typically nested in a write transaction.

The PG migration set is two steps: `0038_items_search_vector.sql` adds the column + index, `0039_backfill_items_search_vector.sql` populates `search_vector` for every existing row using the same field set as the write-time indexer, so any DB running the migrator catches up cleanly. The backfill doesn't consult per-type `searchable: false` opt-outs (those are TS-side metadata): back-filled rows surface a slightly broader vector than their type metadata implies until the next write rewrites them, never narrower.

## Per-tenant quotas

Per-tenant resource ceilings are stored in `tenant_quotas` (PK `tenant_id`); missing rows / NULL columns fall back to env defaults (`MARFA_DEFAULT_QUOTA_*`). Counts are computed on-demand via `COUNT(*)` on the underlying tables at quota-check time, no eager-increment / reconcile machinery (the eager path is a follow-on once load measurement justifies the complexity).

`enforceQuota(c, storage, resource, increment)` is the gate. It's a no-op for tenant-less keys (single-tenant self-hosts + platform admin), so the existing instance-wide flow is unaffected. Routes wired: `POST /webhooks` (resource: `webhooks`), `POST /items` (resource: `items`), `POST /blobs` (both `blobs` count and `storage_bytes` sum). The `count(...)` store method computes everything on demand: `COUNT(*)` for count-style resources, `SUM(size)` for `storage_bytes`.

Per-tenant `rate_per_minute_limit` enforcement lives in the rate-limit middleware, applied as a second window on top of the existing per-credential cap. A noisy single credential is bounded by the credential cap; a tenant's collective fleet is bounded by the tenant cap. The middleware caches each tenant's ceiling in-process for 60s to avoid a DB roundtrip per request; tenant-cap changes take up to 60s to propagate. Skipped for tenant-less keys.

Admin surface: `GET /tenants/:id/quotas` and `PUT /tenants/:id/quotas` (platform-admin only). Tenant-admin's read-own surface (`GET /tenants/me/quotas`) lands separately.

Errors: `quota_exceeded` (HTTP 429) with `details: { resource, limit, current }` so SDK / CLI / operator alerts can wire off the shape.

## Blob storage tenant scoping

The `blobs` metadata table has a composite PK on `(tenant_id, hash)`. Different tenants uploading the same hash bytes get separate metadata rows; the storage backend (filesystem / S3) still keys by hash globally so the physical file is shared (content-addressed deduplication preserved). `tenant_id` is `NOT NULL DEFAULT ''` — empty string is the sentinel for instance-wide / single-tenant / platform-admin uploads, keeping the composite PK clean across both dialects.

`storage.blobs.{register, get, remove}` take an explicit `tenantId` parameter; the route layer threads `key.tenant_id ?? ""` so platform-admin uploads on hosted instances and all uploads on single-tenant self-hosts go to the empty-string row. Cross-tenant probes (`GET /blobs/:hash` from a tenant that hasn't uploaded those bytes) return 404. `storage.blobs.removeAllForHash` exists for the platform-admin orphan-cleanup path that nukes a hash from every tenant.

The storage interface's `listAll` / `count` are unscoped by design, for admin reconcile + metrics surfaces only.

## Email transport

Pluggable transport for transactional email. Three backends in-tree, picked by `MARFA_EMAIL_BACKEND`:

- **`cloudflare`** — Cloudflare Email Service REST API. POSTs `{ from, to, subject, html, text, reply_to }` to `https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send` with `Authorization: Bearer <token>`. Returns `{ ok: true, messageId }` on 2xx (messageId synthesized from the idempotency key — CF doesn't return a native id); `{ ok: false, retryable: false }` on 4xx; `{ ok: false, retryable: true }` on 5xx / 429 / network errors.
- **`smtp`** — `nodemailer`-backed self-host fallback. Idempotency key flows through as an `X-Idempotency-Key` header for MTA-side log correlation (no API-level dedupe). 4xx SMTP codes flag retryable; 5xx don't.
- **`none`** — explicit "unconfigured" backend. Always returns `{ ok: false, error: "email_transport_not_configured", retryable: false }`. Default if `MARFA_EMAIL_BACKEND` unset. Surfaces a clean 503 instead of silent dead-lettering.

**Sender-domain guard.** `senderDomainCheck` runs at boot when `MARFA_EMAIL_BACKEND=cloudflare`. If `MARFA_EMAIL_FROM` doesn't end in `@mail.marfa.so` (the verified Cloudflare send domain), the server fails loud at startup. Skipped under `NODE_ENV=test`.

**Idempotency caveat.** Cloudflare Email Service does NOT honor any documented send-time idempotency header. The `idempotencyKey` field on `EmailMessage` flows through to internal audit + log correlation but does not influence the CF send path. A transient retry of the same send can produce duplicate deliveries, acceptable for the three transactional flows wired today (each ships a single-use token; a second send is semantically harmless).

**Suppression handling.** Cloudflare maintains its own internal hard-bounce suppression list across the account. Sends to a suppressed address return a 4xx from CF; the server surfaces it through structured logs and returns `{ ok: false, retryable: false }` to the caller. **No server-side `email_suppressions` table.** Suppression is owned entirely by Cloudflare's account-wide list; the server keeps no webhook → table → pre-send-check chain of its own.

**Privacy posture for send-time logs.** On non-2xx the transport logs HTTP status, CF error code + message, recipient _domain_ only (e.g. `gmail.com`), backend identifier, and the message's `tags`. It never logs the full recipient address, email body (html / text), subject line, or idempotency-key contents. With suppression owned by Cloudflare and no per-recipient records kept server-side, server logs must not introduce a parallel PII trail through the back door.

**The `email.suppressed` audit action.** Not emitted by the current backend; suppression is tracked at the Cloudflare account level (above), so no audit row is written for it.

## Email verification on sign-up

Every new sign-up gets `auth_user.email_verified = false` and the better-auth instance carries `emailAndPassword.requireEmailVerification: true`, so password sign-in is blocked until the user clicks the verification link.

- **Hook.** `emailVerification.sendOnSignUp: true` + the `sendVerificationEmail` callback wired to the rich transport (HTML template at `auth/email-templates/verify-email.ts`, idempotency key per `(user_id, token)` for log correlation). Token TTL: 3600s (1h, set via `emailVerification.expiresIn`).
- **Auto-sign-in on verify.** `emailVerification.autoSignInAfterVerification: true` — clicking the verification link establishes a session, so the just-verified user lands signed in (and resumes the OAuth flow they signed up from) rather than bouncing back to sign-in. Better Auth mints the session + Set-Cookie on its verify endpoint only under this flag; the `GET /auth/verify-email` wrapper forwards that cookie onto the success page. Same trust model as the magic-link sign-in already exposed.
- **Sign-up wrapper.** `POST /auth/sign-up` detects the verification-required path by the absence of a Set-Cookie on better-auth's response (which `shouldSkipAutoSignIn` produces when `requireEmailVerification` is on) and 302s to `/auth/verify-email?email=…&return_to=…` instead of `return_to`.
- **Verify-email page.** `GET /auth/verify-email` renders one of four states: `pending` (no token, just-redirected after sign-up), `success` (token validated), `failure` (expired / invalid / unknown — falls back to a resend form), `resent` (after a successful resend). Uses the shared auth-page layout.
- **Resend.** `POST /auth/verify-email/resend` calls better-auth's `POST /auth/send-verification-email` and redirects back with `?sent=1` regardless of whether the address actually exists, to avoid email enumeration.
- **Existing-account migration.** Migration `0042_grandfather_email_verified.sql` (PG) / `0035_…` (SQLite) flips `email_verified=true` for any account predating the verification requirement, so the requirement doesn't lock them out. Fresh DBs match zero rows; the migration is a no-op there.
- **Tests.** `markEmailVerified(storage, email)` in `src/test-utils.ts` is the test-side stand-in for clicking the verify link, a direct `UPDATE auth_user SET email_verified = TRUE WHERE LOWER(email) = ?`. Use it between sign-up and sign-in in any test needing an authenticated session after sign-up.

## Forgot-password + reset

End-user surface for resetting a forgotten password. Sits on top of better-auth's `request-password-reset` + `reset-password` endpoints, but the email URL bypasses better-auth's intermediate validate-and-redirect GET: our hook constructs a URL pointing at our themed `/auth/reset-password` page directly. Token validation happens on POST.

- **Routes.** `GET /auth/forgot-password` (email form), `POST /auth/forgot-password` (soft-fail dispatch), `GET /auth/reset-password?token=…` (renders the new-password form), `POST /auth/reset-password` (validates fields, dispatches to better-auth, renders success/failure).
- **Hook.** `emailAndPassword.sendResetPassword` builds an in-house URL (`${baseURL}/auth/reset-password?token=…`) and routes the email through the rich Marfa transport (idempotency key per `(user_id, token)` for log correlation). Conditional on a real backend, same gate pattern as the email verification flow.
- **Token TTL.** `resetPasswordTokenExpiresIn: 3600` (1 hour). Single-use; better-auth deletes the verification row on successful reset.
- **Session revocation.** `revokeSessionsOnPasswordReset: true` — every other session for the user is dropped on a successful reset. The user must re-sign-in everywhere.
- **Per-email throttle.** `auth/per-email-throttle.ts` mints `PerEmailThrottle` instances. The forgot-password router holds one (3/hour per email, in-memory). Layered on top of the per-IP `pathLimits` cap (`/auth/forgot-password: 30`) in `middleware/rate-limit.ts`.
- **No-enumeration invariant.** `POST /auth/forgot-password` always 302s with `?sent=1` regardless of whether the address exists, whether the upstream succeeded, or whether the email transport delivered. Better-auth's `request-password-reset` endpoint enforces the same shape upstream (timing-safe). The throttle path is the only branch that surfaces a different state (`?error=rate_limited`), and it does so based on the email itself, not on whether the account exists, so no enumeration leaks there either.
- **Multi-instance.** Throttle is in-memory only. Multi-instance deployments need a shared counter (Redis); deferred until hosted-multi-tenant lights up.
- **Tests.** `password-reset.test.ts` exercises the full sign-up → forgot → DB-token-read → reset → sign-in round-trip (plus single-use replay rejection + session revocation). `readLatestResetToken(storage)` in `test-utils.ts` reads the most recent `auth_verification` row, used by the integration test in lieu of intercepting the email transport.

## Auth audit rows

Every auth-side wrapper writes a stable-shape audit row through `storage.audit.log`. The shape is uniform across actions — `{ action, resource_type, resource_id, client_ip, details }` — so an operator querying `audit_log` can correlate auth events without matching ad-hoc field names.

Actions emitted today:

| Action                                             | Triggered by                                                                                                                                                    | resource_id                                   | details                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `auth.sign_up`                                     | `POST /auth/sign-up` success                                                                                                                                    | email                                         | `{ email }`                                                        |
| `auth.sign_up.provision_failed`                    | Sign-up flow created the better-auth user but tenant / admin-key provisioning failed (rollback path)                                                            | `auth_user_id` (or email if pre-mint failure) | `{ email, error }`                                                 |
| `auth.sign_in.success`                             | `POST /auth/sign-in` success (password or magic)                                                                                                                | email                                         | `{ email, method: "password" \| "magic" }`                         |
| `auth.sign_in.failed`                              | `POST /auth/sign-in` failure                                                                                                                                    | email                                         | `{ email, method, reason }`                                        |
| `auth.password_reset.requested`                    | `POST /auth/forgot-password` (always — captures attempts)                                                                                                       | email                                         | `{ email }`                                                        |
| `auth.password_reset.completed`                    | `POST /auth/reset-password` success                                                                                                                             | token-prefix                                  | `{ token_prefix }`                                                 |
| `auth.email.verified`                              | `GET /auth/verify-email?token=…` success                                                                                                                        | token-prefix                                  | `{ token_prefix }`                                                 |
| `auth.account.delete_requested`                    | `POST /auth/account/delete` success — user initiates account deletion                                                                                           | `auth_user_id`                                | (none — no email PII in audit)                                     |
| `auth.account.delete_confirmed`                    | `GET /auth/account/delete/confirm?token=…` success — user clicks the confirm link                                                                               | `auth_user_id`                                | (none — no email PII in audit)                                     |
| `auth.account.delete_cancelled`                    | Cancel route (POST `/auth/account/delete/cancel` or GET `/auth/account/cancel`) where `cancelPendingDeletion` matched a row                                     | `auth_user_id`                                | `{ source: "session" \| "link" }`                                  |
| `auth.account.cancel_attempted_but_already_purged` | Cancel route reached but `cancelPendingDeletion` matched zero rows (cascade committed before the cancel UPDATE)                                                 | `auth_user_id`                                | `{ source: "session" \| "link" }`                                  |
| `auth.account.sign_in_blocked_pending_deletion`    | Deletion-guard middleware intercepts a sign-in attempt against a pending-deletion account                                                                       | `auth_user_id`                                | (none — no email PII in audit)                                     |
| `auth.account.hard_deleted`                        | `deleteAccountCascade` transaction commits hard-delete (emitted from `storage/{pg,sqlite}/account-cascade.ts`; survives the post-cascade `redactForUser` sweep) | `auth_user_id`                                | `{ tenant_id, redacted: false }`                                   |
| `auth.grant.created`                               | Code-flow: `POST /auth/authorize/decision` accept. Device-flow: `POST /auth/device/consent` approve (both consent surfaces emit)                                | client_id                                     | `{ client_id, user_id, scopes, grant_item_id, source?, created? }` |
| `auth.grant.revoked`                               | `DELETE /auth/grants/:id` and `POST /auth/grants/:id/revoke`                                                                                                    | client_id                                     | `{ client_id, user_id, grant_item_id }`                            |

**Emission sources.** Most rows are written by route wrappers (`routes/auth-account.ts`, `routes/auth-pages.ts`). Two come from elsewhere by design: `auth.account.sign_in_blocked_pending_deletion` from `middleware/account-deletion-guard.ts` (the sign-in interception sits in middleware to be path-agnostic across better-auth's various sign-in endpoints), and `auth.account.hard_deleted` from `storage/{pg,sqlite}/account-cascade.ts` (must be inside the cascade transaction so the row commits atomically with the deletion and survives the same-transaction `redactForUser` sweep that nukes every other audit row referencing the user).

The `auth.account.cancel_attempted_but_already_purged` row exists for honesty in the operator trail. The POST cancel pre-checks `getAccountLifecycle` and short-circuits to 400 `not_pending_deletion` on the normal "already active" / "already gone" case, but a TOCTOU window remains between that read and the `cancelPendingDeletion` UPDATE. When the cascade commits inside that window (or, for the GET-by-link path with no pre-check, at any point before the UPDATE), the UPDATE matches zero rows. The route renders the honest page / response and writes this audit action instead of the standard `auth.account.delete_cancelled` row that would lie about a cancel that never happened.

Calls are fire-and-forget (`void storage.audit.log(...)`); audit failures must never block the user-facing flow. `client_ip` threads through `c.var.clientIp`. The one exception is `auth.account.hard_deleted`, which is `await`-ed inside the cascade transaction so the row commits atomically.

Both `auth.grant.*` rows emit from explicit Marfa route handlers, not from the `@better-auth/oauth-provider` plugin's `hooks.after` matchers. The hooks fire after the plugin's catch-all completes but with limited body context — `/oauth2/consent` reads `client_id` from the signed `oauth_query`, and `/oauth2/revoke` carries a token-in-hand rather than `(client_id, user_id)`. The explicit Marfa handlers have those values from the request body:

- **Code-flow consent** → `routes/auth-consent.ts` `POST /auth/authorize/decision` (which the consent form posts to, then proxies to the plugin's `/oauth2/consent`).
- **Device-flow consent** → `routes/auth-pages.ts` `POST /auth/device/consent` approve path; the audit row carries `source: "device"` to distinguish from code-flow + `created: true|false` to distinguish first-consent from re-consent.
- **Revoke** → `routes/auth-pages.ts` `DELETE /auth/grants/:id` + `POST /auth/grants/:id/revoke`.

`client_id` + `scopes` for the consent rows are read from the **verified** `oauth_query` (the plugin-signed query string), not from form fields — form values can't widen scopes or swap client identity. The shell plugin's `hooks.before` matcher in `auth/oauth-provider.ts` is reserved for refresh-replay access-token revocation; no projection or audit emit lives in the plugin shell.

## Per-IP rate limits on auth surfaces

`middleware/rate-limit.ts`'s `pathLimits` carry small per-IP caps on every auth-abuse-prone endpoint. The middleware iterates entries in object insertion order and takes the FIRST `path.startsWith(prefix)` match, so more-specific prefixes (`/auth/sign-in/magic-link`) MUST appear before broader siblings (`/auth/sign-in`).

Defaults (per-minute window per IP):

| Path                        | Cap |
| --------------------------- | --- |
| `/auth/sign-in/magic-link`  | 5   |
| `/auth/sign-in/email`       | 10  |
| `/auth/sign-in`             | 10  |
| `/auth/sign-up`             | 5   |
| `/auth/forgot-password`     | 5   |
| `/auth/reset-password`      | 10  |
| `/auth/verify-email/resend` | 5   |
| `/auth/oauth2/token`        | 60  |
| `/keys`                     | 200 |

Per-email throttle on `/auth/forgot-password` (3/hour, in-route, `auth/per-email-throttle.ts`) sits inside the per-IP cap: bot-net protection on the IP layer, account-protection on the email layer. The window is shared (`config.rateLimitWindowMs`, default 60s); per-path windows would need a middleware refactor, deferred.

## Passkey UI

Browser-side WebAuthn ceremony on top of better-auth's passkey plugin.

- **Static asset.** `auth-static/passkey-js.ts` exports `PASSKEY_JS` (string template literal, same bundling pattern as `auth-css.ts`). Served from `GET /auth/static/passkey.js` with `Cache-Control: public, max-age=3600` + strong ETag. Public route, no auth required.
- **Surface.** Exposes `window.MarfaPasskey.{enroll, signIn, isSupported}`. Pages wire onClick handlers; the script handles base64url ⇄ ArrayBuffer conversion + `RegistrationResponseJSON` / `AuthenticationResponseJSON` shaping for better-auth's `verify-registration` + `verify-authentication` endpoints.
- **Enroll page.** `GET /auth/passkey/enroll` — auth-gated (redirects to `/auth/sign-in?return_to=` when no session). Inline click handler calls `MarfaPasskey.enroll()`. Hides itself on browsers without `window.PublicKeyCredential` or non-secure-context; a fallback paragraph explains the requirement.
- **Sign-in.** `/auth/sign-in` carries a "Use a passkey" button (also hidden when unsupported). Inline handler runs the auth ceremony and `window.location.assign(returnTo)` on success. Browser-side `JSON.stringify(returnTo).replace(/</...)` escape prevents `</script>` breakouts even though `validateReturnTo` already rejects off-origin paths.
- **Capability detection.** Done client-side in JS, no UA sniffing. `isSupported()` checks `window.isSecureContext` + `PublicKeyCredential` + `navigator.credentials.{create,get}`.
- **Tests.** `passkey-enroll-page.test.ts` covers the renderer (link to script, fallback paragraph, escape paths) + the route auth gate. The static-asset route gets ETag + 304 + content-type assertions. The full WebAuthn round-trip is browser-side and exercised in a manual cross-browser walkthrough (Chrome on macOS Touch ID, Safari on iOS iCloud Keychain, Chrome on Android).

## Re-consent diff

When a user OAuth-grants the same client a second time and the requested scopes differ from last time, the consent screen renders a diff instead of the flat read / write split.

- **Lookup.** `GET /auth/authorize` queries `system.connection` items in the consenting user's tenant for an active `app` matching the request's `client_id`. Most-recently-granted wins. The grant's `properties.scopes` literal set is threaded into `renderConsentScreen` as `priorScopes`.
- **Hosted-mode only.** The user → tenant binding lives in `storage.users` (hosted mode). In keys mode there's no per-user tenant, so the lookup is skipped and the screen renders flat. Defensible: keys mode is single-user self-host where a re-consent is rare.
- **Pure diff helper.** `routes/consent-diff.ts` exports `computeConsentDiff(prev, next): { kept, added, removed }`. Set difference on opaque scope literals (`<typePattern>:<verb>`); preserves `next`-side ordering, de-duplicates.
- **Rendering.** `consent.ts` switches on `priorScopes`:
  - Three group blocks instead of read/write — `Previously granted` (kept), `New permissions` (added), `No longer requested` (removed). Empty groups are omitted.
  - Removed scopes render as static rows with strikethrough on the literal pill: they're being dropped, not re-granted, so no checkbox.
  - The H1 copy switches from "wants to access your data" to "is requesting updated access to your data".
- **CSS.** `auth.css` adds `.section--kept` / `.section--added` / `.section--removed` modifiers (subtle accent borders + tinted backgrounds) and `.scope-row--removed` (line-through + soft opacity).

## Security page

User-facing page at `/auth/security` listing connected apps and active sessions, with revoke buttons.

- **Connected apps section** — `system.connection` items of kind `app` in the user's tenant. Each row: client name (resolved by joining `oauth_clients` in a single batch list), scope chips, granted-at, last-used-at. Revoke button POSTs to `/auth/grants/:id/revoke` (form-friendly counterpart to the existing `DELETE /auth/grants/:id`); on success the page redirects back with `?notice=grant_revoked`.
- **Active sessions section** — better-auth's `GET /auth/list-sessions` output, mapped to `SecurityPageSession` rows. UA is parsed to a friendly device hint (Mac / iPhone / Windows / etc); IP is shown raw. Each row carries a Revoke button POSTing to `/auth/sessions/:id/revoke` — the handler looks the session up by id in `list-sessions`, extracts the token, forwards to better-auth's `POST /auth/revoke-session` (token-keyed upstream). The current-session row is tagged "current device" and its Revoke button is disabled (use Sign out everywhere instead).
- **Sign out everywhere** — bottom-of-page button POSTs to `/auth/sessions/sign-out-all`, which forwards to better-auth's `POST /auth/revoke-sessions` (drops every session for this user, including current) and redirects to `/auth/sign-in`.
- **Notice flash** — `?notice=…` query param maps to a banner at the top of the page (`grant_revoked`, `session_revoked`, `session_not_found`, `cannot_revoke_current`, etc). Unknown codes resolve to no banner, not a 500.
- **Auth gate** — all four handlers run through `requireConsentSession` (same gate as `/auth/authorize`). Unauthenticated requests 302 to `/auth/sign-in?return_to=…`.

## Auth + email preview gallery (dev tool)

`packages/server/scripts/auth-gallery.ts` (+ `auth-gallery-fixtures.ts`) is a zero-database dev tool for eyeballing every hosted auth page and transactional email in every state without standing up the server or clicking through flows. Run it with `pnpm --filter @withmarfa/server auth:gallery`; for a fixed port use `PORT=<n> pnpm exec tsx scripts/auth-gallery.ts` from `packages/server` (the pnpm filter does not reliably honor `PORT`). It imports the real page renderers (`routes/*-page.ts`, `routes/consent.ts`, `routes/device-pages.ts`, …), the real email templates (`auth/email-templates/*`), and the real `/auth/static/*` assets, so the preview is exactly what ships, never a re-implementation. The shell has an Auth/Email section toggle, the screens (left) and their states (right), the preview (center), Freeform / Browser / Mobile frames, light / system / dark, and arrow-key navigation. It is a script, never a mounted route, so it never deploys. Use it to review any change to the `/auth/*` surface or the email templates before shipping.

## Reserved extension namespaces

The metadata layer's `extensions` map is a free-form JSON sidecar keyed by namespace string. A handful of namespaces are **reserved** with constrained write-access semantics:

- **`connection.runtime`** — verbose per-Connection runtime state for `system.connection` items of kind `integration`: sync cursors, recent error tail, retry counters. Writable only by the connector's own credential (the one referenced by `credential_ref` on the Connection); readable by tenant admins and the connector. The runtime executor is the legitimate writer.
- **`connection.runtime.idempotency`** — the inbound-delivery dedupe window for the same Connection, `{ "<subscription_id>:<delivery_id>": recorded_at_ms }`. Same access semantics as `connection.runtime`, separate namespace because the writer is different: the webhook receipt route, which runs on the HTTP thread outside the dispatch lock. Keeping the two apart is what stops a receipt and a dispatch overwriting each other.

Reserved namespaces are documented here so accidental general-purpose use ("just stash some stuff") doesn't conflict with platform semantics. Application-defined extensions should use namespaced keys that don't collide with reserved roots.

## Per-connection upstream_base_url override

`connection.properties.configuration.upstream_base_url_override` is a per-connection knob the connection-proxy consults before falling back to the credential's `upstream_base_url`. Lets multiple integrations sharing one OAuth credential target different upstream hosts — e.g. `google.contacts` on `people.googleapis.com` while `google.calendar` / `drive` / `tasks` use the same credential row pointing at `www.googleapis.com`. Per-connection rather than per-credential because the override is part of the install-time decision, not the credential's identity. Malformed values (not parseable as a URL) fail loud with `OAUTH_PROXY_UPSTREAM_INVALID` rather than silently routing to the credential's host. Trust model is unchanged from the broader proxy gate: only tenant-admin can install / configure a connection.

## OpenTelemetry

Vendor-neutral OTel for traces + logs, **off by default**. Self-host opts in; hosted Marfa sets `MARFA_OTEL_ENABLED=true`.

**Launch requirement.** The bootstrap (`src/instrumentation.ts`, built to `dist/instrumentation.js`) MUST be loaded via Node `--import`, not a normal import — HTTP auto-instrumentation has to patch `node:http` before the app's modules load, and ESM hoists imports. Dev runs it via `tsx --import ./src/instrumentation.ts`; production runs `node --import ./dist/instrumentation.js dist/index.js`. Importing it from `index.ts` would be too late. When `MARFA_OTEL_ENABLED!=="true"` the bootstrap returns before loading any SDK module, a true no-op.

**Config** (read directly from env by the bootstrap; mirrored into `AppConfig` for the rest of the server). Standard `OTEL_EXPORTER_OTLP_*` vars carry endpoint + headers; `MARFA_OTEL_*` carries policy:

- `MARFA_OTEL_ENABLED` — master toggle (default off).
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — per-signal targets. Each pipeline is built only when its endpoint is set, so hosted test mode (logs → PostHog, no trace store) ships logs without exporting traces.
- `OTEL_EXPORTER_OTLP_HEADERS` — `k=v,k2=v2` (e.g. `Authorization=Bearer <token>`).
- `MARFA_OTEL_SAMPLE_RATIO` — baseline trace sampling (default 0.05). Errors export at 100% regardless.
- `OTEL_SERVICE_NAME` — resource service name (default `marfa-server`).

**Sampling (5% + 100% on errors).** Head sampling can't see a future error, so the SDK records every span (`AlwaysOnSampler`) and an `ErrorBucketFilterSpanProcessor` (`src/otel/error-aware-sampler.ts`) gates _export_ at span end: error / 5xx spans always export, others export only if the trace id falls in the deterministic baseline bucket. Per-trace, stateless, stable across instances.

**PII discipline.** `src/otel/redaction.ts` strips a denylist of sensitive attribute keys and redacts substring matches before export, in a processor registered ahead of the exporter. Header capture is off by default. The denylist is unit-tested (`redaction.test.ts`): a denied key that survives fails the build.

**Logs.** `log()` and the request logger (`middleware/logger.ts`) mirror to the OTel logs pipeline via `@opentelemetry/api-logs` (no-op unless a `LoggerProvider` is registered). Hosted points the logs exporter at PostHog (`/i/v1/logs`); PostHog has no general-trace store, so traces target a generic OTLP collector if one is wanted. `index.ts`'s graceful shutdown awaits `globalThis.__marfaOtelShutdown` so the final batch flushes before exit (matters on the ephemeral hosted container).

## Tests

`pnpm test` from the monorepo root, or `pnpm test:fresh-sqlite` / `pnpm test:pg` for the dialect matrices. Integration tests use `createTestContext()` from `src/test-utils.ts`, which boots an in-process app against a `:memory:` SQLite or a throw-away `postgres:17` container.

**PG test isolation — template-database pattern.** Each PG test file gets its own freshly-cloned database via `CREATE DATABASE … TEMPLATE marfa_test_template`. The template is built once at test-run start (vitest globalSetup at `src/test-global-setup.ts`): it runs migrations into an empty DB and stays quiescent for the rest of the run. Per-file lifecycle lives in `src/storage/pg/test-template.ts`. `createPgTestStorage()` (consumed by `createTestContext` and the few test files that roll their own storage with custom `authMode`) clones the template, opens storage against the clone, and returns an awaitable `cleanup()` that drops the clone with `WITH (FORCE)`. Per-file clones are parallel-safe by construction — no shared-DB truncate races. `cleanup()` is awaitable so afterAll hooks don't starve under heavy admin DDL traffic. `MARFA_TEST_PG_ADMIN_URL` points at the cluster's `postgres` system DB so the lifecycle can issue admin operations; `scripts/test-pg.sh` exports both that and a `DATABASE_URL` for tooling that reads the standard env var.

**PG connection-cap math.** Worker count is Vitest's default (`cpus - 1`); the server's `vitest.config.ts` deliberately does NOT pin a project-level `maxWorkers` (pinning one differs from the sibling projects' default, which forces this project into its own `sequence.groupOrder` group and destabilizes the timing-sensitive cycle-attribution pubsub test). Per-worker connection pressure is bounded by the per-file pool size (`maxPoolSize: 3` in `test-utils.ts`), so peak in-flight connections ≈ `workers × 3 + admin clients (≈1 per worker)`. `scripts/test-pg.sh` bumps the local container to `max_connections=500` for headroom; CI runs on a GitHub-hosted runner (`cpus - 1` ≈ 3 workers) against the postgres image's default `max_connections=100`, comfortably above the ~12 peak there. If a future runner has many more cores, the postgres `max_connections=100` default becomes the bottleneck before the worker count does — either bump `max_connections` on the CI service container (GHA service containers don't expose `command:` directly, so the cleanest path is a custom postgres image or a startup script) or cap workers globally via the root config / `--maxWorkers` so every project shares the same value and stays in one scheduling group.

## Local integrations runtime

Node-bundled integrations substrate. Boots conditionally on `MARFA_INTEGRATION_RUNTIME=local`; replaces the Cloudflare-side execution layer (Workers + Queues + Durable Objects + KV) with an in-process equivalent. The handler authoring surface (`@withmarfa/runtime-sdk`) is unchanged: integrations import the same primitives and run on either substrate.

**Components** (under `src/integrations/local-runtime/`):

- `index.ts` — public entry. `tryStartLocalIntegrationRuntime(options)` returns a `LocalRuntimeBundle` (supervisor + bridge + Hono sub-app exposing `POST /runtime/webhook/:connection_id`) or `null` when the substrate is disabled.
- `supervisor.ts` — central orchestrator. For each dispatch: takes `storage.coordination.withJobLock("connection-dispatch:<connection_id>", …)` for per-Connection single-writer guarantee, mints a credential, snapshots cursor state, hands off to the executor, applies the cursor delta + activity emission on completion. Mirrors the retry/dlq/hop-budget semantics of `runtime-sdk/queue-consumer.ts`, including its first-attempt-throw rule: a handler throw on the first delivery earns one retry, a throw on a redelivery goes terminal. The queue worker runs with `includeMetadata` so `retryCount` is available to make that call.
- `executor.ts` — `worker_thread` pool per integration with `resourceLimits` (`maxOldGenerationSizeMb: 64`, `maxYoungGenerationSizeMb: 16`, `stackSizeMb: 4`). Pool size defaults to 2 threads per integration. Crashes tear down the worker; the pool replaces it. A test-mode `directDispatch` callback bypasses the worker thread for fast unit tests against the supervisor.
- `worker-entry.ts` — entry script the threads load. Imports the integration's `dist/local.js` once on startup, listens on `parentPort` for `WorkerDispatchRequest` payloads, runs `dispatchMessage`, posts `WorkerDispatchResponse` back. Cursor writes journal to an in-memory adapter shipped back as a delta; the main thread merges under the advisory lock that gated the dispatch.
- `pg-cursor-store.ts` — per-Connection state plumbing, split by writer. Cursors, recent-errors tail, and next-run-at live under `connection.runtime` (written by the supervisor under the dispatch lock); the inbound-delivery idempotency window lives under `connection.runtime.idempotency` (written by the receipt route, which holds no lock). Every mutation goes through `metadata.mutateExtension` so the read / mutate / write cycle is atomic — the advisory lock cannot cover the receipt path, so the storage layer has to. The idempotency window keeps the freshest `IDEMPOTENCY_WINDOW_SIZE` (256) entries and bounds by TTL; recent_errors keeps the freshest 16.
- `credentials.ts` — short-circuit for the SDK's `mintCredential` callback. Calls `storage.keys.createRuntimeCredential` directly with manifest-derived `extension_permissions` (always granting `connection.runtime: write` plus manifest extras), bypassing the lease-broker HTTP round-trip the Cloudflare side uses.
- `walker.ts` — `fanOutSchedule(storage, runtime, integrationName, now)` walks active local Connections for an integration on each cron tick and enqueues a `ScheduleMessage` per Connection. Mirrors `buildEntryForConnection`'s match rules (state=active, kind=integration, manifest opts into `"local"` runtime_compatibility).
- `webhook-receipt.ts` — `POST /runtime/webhook/:connection_id` route, mounted under the root path before any auth middleware. Verifies via `@withmarfa/webhooks` (same adapters as the Cloudflare control plane), runs idempotency via the connection's `connection.runtime.idempotency` map, enqueues a `WebhookMessage`.
- `reactive-bridge.ts` — drains the in-process pubsub and pushes envelopes onto the local queue, mirroring `connections/reactive-run-bridge.ts`'s logic (via `evaluateDispatch` + `buildQueueMessageBody` for the shared per-subscriber gate). Single coordination lock per cluster.
- `registrations.ts` — loads `integrations/<name>/dist/local.js` entries at boot. Skips integrations that haven't shipped a `local.ts` yet or declare `runtime_compatibility` without `"local"`.

**Build invariant.** `tsup.config.ts` MUST list `worker-entry` as a named tsup entry AND externalize `@withmarfa/runtime-sdk` + `@withmarfa/shared`. The named entry produces `dist/worker-entry.js`, which `executor.ts:45` resolves via `new URL("./worker-entry.js", import.meta.url)` after bundling; without it the worker spawn crashes with `MODULE_NOT_FOUND`. The externalization ensures the server bundle and each integration's `dist/local.js` resolve to the same workspace `@withmarfa/runtime-sdk` + `@withmarfa/shared` module instance — both carry module-singleton state (the handler `REGISTRY` in runtime-sdk; the type registry, edge registry, and zod schema caches in shared) that breaks silently if duplicated across the boundary. Vitest doesn't catch either regression because every test uses the executor's `directDispatch` test seam; the `pnpm --filter @withmarfa/server run smoke:worker-entry` script enforces both at build time (wired into `pnpm test:full` and the CI `ci-sqlite` job).

**Per-Connection serialization.** Postgres advisory lock keyed `connection-dispatch:<connection_id>` via `storage.coordination.withJobLock`. Equivalent to the Durable Object single-writer guarantee on the hosted side. Two different Connections can run in parallel; the same Connection serializes.

The lock covers dispatch only. `withJobLock` is a try-lock — it returns `undefined` rather than waiting — so the webhook receipt route cannot take it without either failing deliveries whenever a dispatch is in flight or blocking the HTTP response for the length of a handler run. Receipt-side state is kept correct by the storage layer instead: its own namespace, mutated atomically. Anything else that has to write per-Connection state from outside a dispatch follows the same rule.

**Trust model.** Fault isolation, not adversarial isolation. Operators trust the integrations they install, same posture as installing an npm package in the host app. For untrusted code, run hosted.

**Substrate requires Postgres.** `MARFA_INTEGRATION_RUNTIME=local` with `DB_DIALECT=sqlite` throws a clear startup error pointing at the PG requirement. SQLite self-hosts must keep `=hosted` until they migrate.

**Operator footprint.** Two containers, server + Postgres. No Redis, no extra binary, no Postgres extension dependency. pg-boss creates its own `pgboss` schema inside the same Postgres instance the rest of the server already uses.

**Default.** `MARFA_INTEGRATION_RUNTIME` defaults to `local`. Hosted Marfa deployments + any operator wanting to delegate to the Cloudflare bridge set the env var explicitly to `hosted`.

**Public docs.** The semantic parity sheet between substrates lives in `withmarfa/docs/guides/connections/runtime-substrates.mdx`.
