# @mymehq/server

The Hono HTTP server exposing the Myme API. Private package — never published to npm; deployments build from source.

## Layout

- `src/index.ts` — the entry point. Boots storage, blob backend, retention workers (`TrashPurger`, `VersionThinner`, audit cleanup, event-log cleanup, `AuthSessionCleaner`), and the Hono app.
- `src/app.ts` — composes the router from per-route modules; sets up middleware (auth, rate limit, CORS, logging).
- `src/routes/*.ts` — one file per route group: `items.ts`, `types.ts`, `keys.ts`, `tenants.ts`, `users.ts`, `edges.ts`, `search.ts`, `bulk.ts`, etc. Routes use `@hono/zod-openapi`'s `createRoute` so OpenAPI generation falls out for free.
- `src/storage/` — dual-dialect Drizzle layer. `interface.ts` defines `Storage`, `ItemStore`, `KeyStore`, etc.; `pg/` and `sqlite/` are sibling implementations. `connection.ts` imports the bootstrap `SCHEMA_SQL` from a sibling `schema-sql.generated.ts` — auto-generated from migrations by `scripts/generate-schema-sql.ts` (T-145). Never hand-edit the generated file.
- `src/middleware/auth.ts` — bearer-token + OAuth resolution; sets `c.var.apiKey`.
- `src/test-utils.ts` — `createTestContext()` for in-process integration tests across PG/SQLite.

## Schema changes

When changing a column or adding a table:

1. Edit the Drizzle schema (`storage/{pg,sqlite}/schema.ts`).
2. Generate migrations: `pnpm --filter @mymehq/server run migrate:pg:generate` and `migrate:sqlite:generate`. Each command refreshes the corresponding `src/storage/<dialect>/schema-sql.generated.ts` automatically as a post-step (T-145) — the PG one needs Docker running so it can spin up a transient `postgres:17` to dump the schema. **Never hand-edit a `schema-sql.generated.ts` file**; the next regen overwrites it and the `schema-sql-freshness` CI job catches drift.
3. Hand-review the generated SQL under `drizzle/{pg,sqlite}/` — Drizzle Kit sometimes produces DROP+ADD when a careful ALTER+UPDATE+ALTER would be lossless. Edit the SQL by hand if needed, then re-run the regen so `schema-sql.generated.ts` reflects the edit. For multi-statement SQLite migrations, ensure `--> statement-breakpoint` separates each `;` — libsql's migrator silently drops trailing statements without it (T-145 surfaced + fixed three pre-existing instances of this).
4. Update both `_journal.json` files under `drizzle/{pg,sqlite}/meta/` to add the new entry (Drizzle Kit usually handles this automatically when it generates the migration).
5. Run `pnpm test:fresh-sqlite` and `pnpm test:pg` to verify the migration is correctly applied to existing databases AND the bootstrap path produces the same shape.

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
7. Stamp `source`, `tier` from credential defaults.
8. Run the storage write inside a transaction.
9. Hydrate the response (edges, metadata) and return.

Read routes apply the source-filter lever in step 4 before issuing the storage query.

## Request context (`c.var`)

Middleware composes shared per-request state on `c.var`. Routes read these directly rather than re-resolving:

- **`apiKey: ApiKey | undefined`** — set by `authMiddleware` from the bearer token. Carries `tenant_id`, `connection_id` (runtime credentials), `source`, role, and the permission maps. `undefined` for anonymous requests.
- **`authType: "api_key" | "oauth" | undefined`** — distinguishes how the bearer was resolved.
- **`clientIp: string | null`** — resolved by `clientIpMiddleware` against `TRUSTED_PROXY_CIDRS`. Threaded into every `audit.log` call (T-027).
- **`requestId: string`** — per-request UUID for log correlation.
- **`cycle: { originatingConnectionId: string | null; hopCount: number }`** — cycle metadata (T-039), resolved by `cycleMiddleware` after auth. Reads `X-Myme-Cycle-Origin` / `X-Myme-Cycle-Hop` (a connector continuing a chain), or falls back to the api key's connection binding (a connector kicking off a chain), or stamps the human sentinel `{ null, 0 }` for ordinary user requests. **T-144 — routes do NOT spread `...c.var.cycle` into `publish(...)` anymore.** The resolved cycle is written to `cycleRequestContext` (AsyncLocalStorage at `src/cycle-context.ts`) alongside `c.var.cycle`; `pubsub.publish` and `pubsub.publishEdge` read it automatically. `c.var.cycle` stays exposed for diagnostic reads only. **Never `null`** — the sentinel is always present.

Middleware order in `app.ts`: logger → CORS → client-ip → auth → cycle → rate-limit → routes. The cycle resolver depends on auth's `c.var.apiKey`, so it must run after auth.

## Cycle metadata propagation (T-144)

Same shape as Postgres RLS (T-025): state that must stay coherent across a request flows through one mechanism (middleware + AsyncLocalStorage), not by every caller spreading the value. `cycleMiddleware` resolves the per-request cycle and writes it to both `c.var.cycle` (diagnostic) and `cycleRequestContext` (the ALS at `src/cycle-context.ts`). `pubsub.publish` and `pubsub.publishEdge` consult the ALS automatically; route handlers no longer carry `...c.var.cycle` on every publish call.

**Explicit override path.** Server-internal callers that need to synthesise a cycle (rather than propagate the request's) can pass `originatingConnectionId` and/or `hopCount` explicitly on the `publish` event argument — the resolver short-circuits to the explicit values when either field is present. No internal caller exercises this today; the `POST /connections/preview-event` route runs its own duplicate of `passesHopBudget`'s effective-hop logic against `body.cycle` for hypothetical-event reasoning (it never calls `publish`).

**Outside-request fallback.** When the ALS is empty AND no explicit override is supplied (e.g. the reactive-run bridge's `stop()` sentinel publish), the resolver falls through to `{ originatingConnectionId: null, hopCount: 0 }` — the human-sentinel shape that bypasses the budget.

**Wire-tampering defence preserved.** The `Math.max(hopCount, 1)` floor inside `passesHopBudget` (and the duplicate in `POST /connections/preview-event`) is kept. It defends against malformed inbound `X-Myme-Cycle-Hop` headers (origin set but `hopCount: 0`) — the ALS refactor removes the contributor-discipline failure mode but does not subsume the wire-tampering one.

## Postgres RLS (T-025)

Two coordinated PRs land RLS as defence-in-depth beneath the application-layer tenant scoping.

**Part 1 — schema scaffold.** Migration `0035_rls_application_role.sql` creates the `myme_app` non-owner role, grants CRUD on the eleven tenant-scoped tables (`items`, `edges`, `versions`, `metadata`, `api_keys`, `blobs`, `custom_types`, `custom_edge_types`, `outbound_webhooks`, `audit_log`, `event_log`) plus instance-wide reads on `tenants`/`settings`, and adds per-table RLS policies keyed on `current_setting('myme.tenant_id', true)`. Bootstrap mirror in `pg/connection.ts` applies the same DDL on fresh databases. The metadata + versions tables have no direct `tenant_id` column — their policies join via items. The blobs table uses `tenant_id = ''` instead of NULL because its composite PK requires `tenant_id NOT NULL DEFAULT ''`.

**Part 2 — connection-pool wiring.** Migration `0037_rls_extend_grants.sql` extends GRANTs to the remaining tables `myme_app` needs (`inbound_webhooks`, `inbound_webhook_events`, `connection_oauth_tokens`, `connection_leased_tokens`, `oauth_*`, `users`) plus identity-column sequences.

**Part 3 follow-on (Wave B Part 4) — direct-tenant_id policies.** Migration `0040_rls_extend_policies.sql` extends per-table RLS policies to the three direct-tenant*id tables that got GRANTs in Part 2 but no policies (`inbound_webhooks`, `connection_oauth_tokens`, `connection_leased_tokens`). Same equality-on-`current_setting` + NULL-allowance shape as Part 1's eleven tables. The other tables that got GRANTs in 0037 don't carry direct `tenant_id` columns (oauth*\*, users, tenant_quotas) and use a different gating shape — application-layer routes filter via PK joins; not in scope for this RLS layer.

The Drizzle PG instance is wrapped in a per-request context proxy (`storage/pg/request-context.ts`) that consults an `AsyncLocalStorage` on every method access. The RLS middleware (`middleware/rls-tenant-context.ts`) wraps each tenant-bounded request in `db.transaction(async tx => { SELECT set_config('myme.tenant_id', $1, true); SET LOCAL ROLE myme_app; ... })` and stores `tx` on the ALS. Storage calls during the request flow through `tx`'s reserved connection and are subject to the policies.

**Activation.** Gated by `MYME_RLS_ENFORCE` (**default `true` from T-146**; was `false` pre-T-146). Explicit opt-out is `MYME_RLS_ENFORCE=false` — convenient for diagnosis but should not run in production. With the flag off, the proxy still exists but the middleware never installs an ALS context, so all queries fall through to the unwrapped base instance and run as the connection owner (RLS bypassed by virtue of ownership). SQLite is unaffected — the middleware skips when `storage.pgDb` is undefined.

**Bypass paths.** Two intentional carve-outs from the role-switch wrapper:

- **Platform-admin / anonymous / bootstrap** — requests with no `apiKey.tenant_id` skip the wrapper and run as the owner. `requireAdmin` is still load-bearing for cross-tenant authority.
- **Better Auth** — `storage.betterAuthDb` is the unwrapped base instance. The auth library manages its own connection context outside the data-plane request middleware; auth tables (`auth_*`) carry no RLS.

Streaming responses (`/events` SSE + `/export` NDJSON / archive) used to be a third bypass — wrapping them in a transaction would pin a pool connection for the response's full duration. T-146 closes that gap via a different mechanism (see next section). They remain exempt from the transaction wrapper but apply session-level RLS internally.

## Streaming RLS (T-146)

`/events` and `/export` apply RLS at the database layer through a different mechanism than the request middleware. They cannot wrap themselves in a transaction (long-lived txns wedge pool slots, accumulate locks, risk deadlocks), so each stream reserves a dedicated pool connection and applies **session-level** `SET ROLE myme_app` + `set_config('myme.tenant_id', $1, false)` (third arg `false` = NOT `SET LOCAL`). Storage reads inside the stream flow through that connection via the existing `pgRequestContext` ALS proxy — Drizzle bound to the reserved connection becomes the `tx` substitute.

The helper lives at `storage/pg/streaming-rls.ts`. Public surface: `acquireStreamRls(client, tenantId) -> StreamRlsContext` and `withStreamRls(client, tenantId, fn)`. The context carries `release()` — idempotent cleanup that runs `DISCARD ALL` on the connection (canonical reset: drops role, every SET, prepared statements, sequences) then returns the connection to the pool. If `DISCARD ALL` fails the connection is destroyed via `reserved.end()` instead — a reset failure means the connection is in an unknown state, and a connection returned to the pool with `myme_app` role + a leaked `myme.tenant_id` would be served to a future request as that tenant. The destroy fallback is the load-bearing safety property.

**Cleanup invariants:**

- `release()` is idempotent — safe to call from multiple exit paths.
- `/export` wires cleanup in a `try/finally` around the start callback's body (single linear path).
- `/events` wires cleanup into the existing `cleanup()` closure, which fires from (a) pump completion, (b) replay errors, (c) the `catchup_too_old` terminal path, (d) the `c.req.raw.signal` abort listener on client disconnect. Acquisition failure aborts the stream cleanly via `controller.error` — no rows ever sent.
- If `DISCARD ALL` fails the connection is destroyed via `reserved.end()` rather than returned poisoned.

**Pool-slot consumption.** Each active stream consumes one pool slot for its lifetime. Today's pool size is 10 (`pg/connection.ts`); the bottleneck only bites at 10+ concurrent streams per server instance. Watch in staging; if it bites, partition into a dedicated streaming sub-pool.

**Activation conditions.** All three must hold for the stream to acquire an RLS context:

- `options.rlsEnforce === true` (env-driven; default on for T-146).
- `options.pgClient !== null` (PG dialect; SQLite passes `null`).
- Caller has a tenant_id (workspace_admin / member — not platform-admin / anonymous / single-tenant self-host).

If any condition is false the route runs on the owner connection, matching the per-request middleware's bypass semantics.

**Pre-T-146 historical note.** The original RLS PR (T-025) left `/events` + `/export` as a deliberate gap — `STREAMING_PATH_PREFIXES` in `middleware/rls-tenant-context.ts` exempted them from the transaction wrapper and the docstring acknowledged the depth-of-defence hole. T-146 closes it.

## Per-tenant background cleanup (T-050)

Three cleanup jobs (`TrashPurger`, audit cleanup, event-log cleanup) fan out per-tenant. Each tick the job lists every tenant via `TenantStore.list()`, resolves the effective retention (per-tenant `TenantConfig` override OR env default), and runs the cleanup once per tenant scope plus once for the NULL-tenant bucket (single-tenant self-host items + any unscoped legacy rows).

Per-tenant overrides on `TenantConfig`:

- `audit_retention_days` — overrides `AUDIT_RETENTION_DAYS`.
- `event_log_retention_hours` — overrides `MYME_EVENT_LOG_RETENTION_HOURS`.
- `trash_retention_days` — overrides `TRASH_RETENTION_DAYS`.

`0` disables the job for that tenant — matches the env-default semantics for `TRASH_RETENTION_DAYS=0`. Negatives are rejected at write.

Coordination locks are keyed per-tenant (`<jobName>:<tenant-id>`, plus `<jobName>:_no_tenant` for the NULL bucket) so multi-instance deployments don't double-process a single tenant. Cost is O(tenants) per cleanup tick — cleanup is off the request hot path, so the unbounded scan is acceptable at the scale we're targeting.

The `runTenantCleanup` helper in `storage/retention.ts` is the shared fan-out runner; `TrashPurger.runOnce` accepts an optional `TenantFanout` config that wires the same fan-out semantics for the items-table job.

## Auth session cleanup (T-097)

`AuthSessionCleaner` in `storage/retention.ts` drops `auth_session` rows past their `expires_at`. **Instance-wide, not tenant-scoped** — the table carries no `tenant_id` column, the deletion criterion is purely time-based, and Better Auth itself owns the session TTL. Cluster-wide coordination lock keyed `"auth-session-cleanup"`. Cadence configured via `AUTH_SESSION_CLEANUP_INTERVAL_MS` (default 1h). Logs only on non-zero deletes.

## OAuth scope grammar enforcement (T-045)

OAuth tokens are issued with scopes parsed by `parseScope` in `@mymehq/shared`. At token-resolve time the auth middleware projects them into the synthetic `ApiKey`'s `type_permissions`, `edge_permissions`, and `metadata_permissions` maps. From that point the data plane gates flow through the same helpers used for ordinary API keys:

- **`requireTypeAccess(c, type, level)`** — consults `type_permissions`. Wired on every single-item GET / PATCH / DELETE / restore / transition / version, on every POST `/items` (against `body.type`), and on edge-source and edge-target writes (`POST /items` with `edges`). Admin and workspace_admin bypass; member + OAuth-derived synthetic keys must match the projected permission. List reads use `getTypeFilter` instead — see below.
- **`requireEdgePermission(c, edgeType, level)`** — consults `edge_permissions`. Wired on `POST /edges`, `PATCH /edges/:id`, `DELETE /edges/:id`, and on every edge mutation inside an atomic `POST /items`. Admin and workspace_admin bypass.
- **`requireMetadataPermission(c, subresource, level)`** — consults `metadata_permissions`. Wired on `POST /types` (`metadata.types:write`). Admin and workspace_admin bypass.
- **List-read enforcement via `getTypeFilter`** — list endpoints (`GET /items`, `/search`, `/export`, bulk reads) project `type_permissions` into a storage-layer `allowed_types` filter. Out-of-scope types silently drop from the result set (status 200 with empty data) — implicit denial, not 403. The single-item GET path enforces explicitly via `requireTypeAccess`. Strict rejection on list filter mismatch would force callers to know exactly what's in scope; the implicit-denial shape lets a token pass `?type=X` even with a multi-type scope and get the right results.
- **Empty `allowed_types` filters to zero rows.** The storage layer treats `allowed_types: []` as "no readable types" (forces `1=0` in SQL); previously it silently passed through and returned every row, a real security gap a no-scope token could exploit. Fixed in T-045 alongside the projection wiring.
- **More-restrictive-wins is automatic.** OAuth tokens are synthetic `ApiKey` records built only from the granted scopes — there's no underlying API key whose permissions might be wider. Scope and credential are the same map.

**Force re-consent on T-045 deploy.** [Historical — script removed in T-131. T-131's deploy is itself a hard reset of OAuth state: the legacy `oauth_clients` / `oauth_tokens` / `oauth_codes` tables are dropped; every grant must be re-created via the new flow.]

## OAuth Provider plugin (T-131)

The OAuth-protocol surface is owned by [@better-auth/oauth-provider](https://www.better-auth.com/docs/plugins/oauth-provider) plugin mounted on the better-auth instance. Endpoints land under `/auth/oauth2/*` via the basePath catch-all. The plugin's own tables (`auth_oauth_client`, `auth_oauth_access_token`, `auth_oauth_refresh_token`, `auth_oauth_consent`) replace the dropped `oauth_clients` / `oauth_tokens` / `oauth_codes`.

**Plugin endpoints (via Better Auth basePath `/auth`):**

| Endpoint                                                    | RFC / spec                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /auth/oauth2/authorize` + `POST /auth/oauth2/consent` | Authorization Code + PKCE S256, public clients (no secret)                              |
| `POST /auth/oauth2/token`                                   | `authorization_code`, `refresh_token`, `client_credentials` — refresh rotation built in |
| `POST /auth/oauth2/userinfo`                                | OIDC userinfo                                                                           |
| `POST /auth/oauth2/revoke`                                  | RFC 7009                                                                                |
| `POST /auth/oauth2/introspect`                              | RFC 7662 — new for Myme                                                                 |
| `POST /auth/oauth2/register`                                | RFC 7591 DCR (public — `allowUnauthenticatedClientRegistration: true`)                  |
| `GET /.well-known/oauth-authorization-server`               | RFC 8414 (re-published at root via plugin's exportable helper)                          |
| `GET /.well-known/openid-configuration`                     | OIDC discovery (re-published at root via plugin's exportable helper)                    |
| `GET /auth/jwks`                                            | JWKS for id_token verification                                                          |

**Myme-owned surfaces (kept):**

- `GET /auth/authorize` — Hono consent route in `routes/auth-consent.ts`. The plugin's `consentPage` config redirects here; the route reads `client_id` + `scope` + `code` from query, fetches prior consent for the re-consent diff, renders via the existing `renderConsentScreen`. Form POSTs back to the plugin's `/auth/oauth2/consent`.
- `/auth/device*` — device-flow state machine over the kept `oauth_device_codes` table. Terminal token-issuance step (`POST /auth/device/token`) writes into the plugin's `auth_oauth_access_token` + `auth_oauth_refresh_token` so the bearer middleware resolves device-flow tokens uniformly with code-flow tokens. See `routes/oauth.ts` (kept) for the wiring.
- `/auth/security` + `/auth/grants/*` + `/auth/sessions/*` — user-facing operational surfaces, re-pointed to read from the plugin's tables via `storage.oauthProvider`.

**Bearer middleware (`middleware/auth.ts`):** OAuth-prefix tokens (`myme_at_*`) resolve via `storage.oauthProvider.validateAccessToken(hashApiKey(token, salt))`. The plugin's `storeTokens.hash` is wired to the same HMAC-SHA256 hash function, so the middleware looks up `auth_oauth_access_token.token` directly by hash. Per-request scopes project through the unchanged `scopesToTypePermissions` / `scopesToEdgePermissions` / `scopesToMetadataPermissions` / `scopesToOidcScopes` from `@mymehq/shared`. Opaque tokens carry no embedded claims (claims only ride JWT access tokens, which Myme doesn't issue); the side-channel join (`auth_oauth_access_token.referenceId` → tenant_id, `clientId`+`userId` → `system.connection`) is the correct path for our profile.

**Token tenant binding (`postLogin.consentReferenceId`).** Two parallel hooks bind the plugin's tables to Myme's tenant model. `clientReference` is called at CLIENT-REGISTRATION time and writes `auth_oauth_client.reference_id` (immutable for the life of the client). `postLogin.consentReferenceId` is called at TOKEN-ISSUANCE time and writes `auth_oauth_access_token.reference_id` for every minted token. Both resolve via `resolveTenantIdForAuthUser(storage, user.id)` — same path. Without the `postLogin` block, every issued token would land with `reference_id=NULL` and the bearer middleware would surface them as `tenant_id=undefined` (keys-mode behavior — multi-tenant scoping broken). The `postLogin` config also requires `page` + `shouldRedirect` (the plugin's optional multi-account-selection UX); Myme has single-account-per-session so `shouldRedirect: () => false` makes the page a no-op.

**Discovery doc issuer field (RFC 8414 §3 — partial deviation, documented).** The bare-root `/.well-known/oauth-authorization-server` + `/.well-known/openid-configuration` paths re-publish the plugin's metadata at the apex, but the `issuer` field they return is `<baseURL>/auth` (the basePath of the better-auth catch-all), not `<baseURL>`. Strict RFC 8414 readers expect `issuer` to match the discovery URL's host (no basePath). Practical impact is bounded: id_token `iss` claims match the discovery doc's `issuer` value, so token-signature validation by RPs works correctly. The discrepancy only bites strict-RFC validators that compare the discovery URL string against the issuer string. A full fix requires reorganising the Better Auth basePath from `/auth` to `/`, which would touch every route + sign-in / sign-up / consent surface and is out of T-131 scope. Tracked as a known limitation rather than a follow-on; revisit if/when a strict-validating RP needs to integrate.

**Grant projection.** A sibling shell plugin (`buildOauthProjectionPlugin` in `auth/oauth-provider.ts`) hosts hooks for `/oauth2/consent`, `/oauth2/token`, `/oauth2/revoke`, `/oauth2/end-session`. Consent-side projection writes (first-time consent) OR updates (re-consent — refreshes `scopes` + `granted_at` on the existing row) the `system.connection { kind: "app" }` item, in the explicit `POST /auth/authorize/decision` route. Revoke-side projection currently log-and-no-ops; the user-facing `/auth/grants/:id/revoke` handler is the actual cascade path (calls `storage.oauthProvider.revokeTokensForGrant(clientId, userId)`).

**`last_used_at` stamping (code-flow).** The bearer middleware resolves the projected `system.connection` item by `(tenantId, clientId, authUserId)` via `storage.oauthProvider.findGrantItemId` on the first authenticated request inside the debounce window, then stamps `properties.last_used_at` via the existing `storage.oauth.updateLastUsedAt` helper. Two-layer debounce (in-memory cache + DB-side conditional UPDATE) means at most one stamp per grant per 30s window cluster-wide. Device-flow grants continue to stamp at `/auth/device/token` issuance against `row.connection_item_id` (the FK on `oauth_device_codes`).

**Refresh-token replay — closed.** Plugin behaviour verified in source (`index.mjs:747-761`): stale-refresh replay deletes the entire refresh chain for `(clientId, userId)` and returns `invalid_grant`. Plugin does NOT delete access tokens from the same chain — they used to remain valid until TTL (1h default). T-131 follow-on closes the gap: a before-hook on `/oauth2/token` (`detectAndZapReplayedAccessTokens`) hashes the request's `refresh_token`, peeks at the row, and if `revoked: true` pre-emptively deletes access tokens for `(clientId, userId)` via `storage.oauthProvider.revokeAccessTokensForGrant`. The plugin's own logic then runs (returning `invalid_grant`); access tokens are already gone. Best-effort throughout — failures swallowed, the 1h TTL still bounds exposure in the unlikely degraded path.

**JWT plugin (`auth_jwks` table).** Mounted alongside oauth-provider for id_token signing. Auto-generates an RSA key pair on first use; rotates by inserting new rows.

**Scope grammar.** Plugin's `scopes` allowlist is enumerated from `TYPE_REGISTRY.keys()` + `EDGE_TYPE_REGISTRY.keys()` at instance construction (`auth/oauth-provider.ts` → `buildAllowedScopes`). Custom types registered at runtime via `POST /types` are NOT picked up until server restart — acceptable tradeoff; the plugin's scope-allowlist is static.

## FTS dialect parity (T-015)

Both dialects index the same set of property fields and respect the same per-type opt-out. The dialect-agnostic helper `extractSearchableText` in `storage/search-text.ts` is the single source of truth for "what text contributes to FTS for this item."

- **SQLite** uses an FTS5 virtual table (`items_fts`) populated at write time by `SqliteSearchStore.indexSync` / `removeSync`. Five columns: `title`, `body`, `description`, `name`, `extra`. The `extra` column concatenates every other string-typed field declared on the type that isn't `searchable: false`.
- **Postgres** uses a materialised `tsvector` column (`items.search_vector`) populated at write time by `PgSearchStore.index` / `remove` via the same shared text extractor. The column is GIN-indexed (`idx_items_search_vector`); the search query reads the column directly instead of computing `to_tsvector(...)` at query time over the JSON.

`searchable: false` on a type's `FieldDefinition` opts the field out of FTS for both dialects. The flag is honoured for the four core fields (title, body, description, name) via `isFieldSearchableExcluded` and for the long tail via `getSearchableStringFields`. Defaults to `true` (searchable) for backward compatibility — existing types without the flag keep their pre-T-015 behaviour.

`PgSearchStore` writes go through the request-context-aware Drizzle instance (`db.execute(sql\`...\`)`) so an `index()`call inside a`db.transaction(...)` runs on the same reserved connection as the parent INSERT/UPDATE — atomicity preserved. Reads (the search query) use the bare client; search isn't typically nested in a write transaction.

The PG migration set is two steps: `0038_items_search_vector.sql` adds the column + index, `0039_backfill_items_search_vector.sql` populates `search_vector` for every existing row using the same field set as the write-time indexer. Pre-T-015 deployments running the migrator catch up cleanly. The backfill doesn't consult per-type `searchable: false` opt-outs (those are TS-side metadata) — pre-existing rows surface a slightly broader vector than their type metadata implies until the next write rewrites them; never narrower.

## Per-tenant quotas (T-052)

Per-tenant resource ceilings are stored in `tenant_quotas` (PK `tenant_id`); missing rows / NULL columns fall back to env defaults (`MYME_DEFAULT_QUOTA_*`). Counts are computed on-demand via `COUNT(*)` on the underlying tables at quota-check time — no eager-increment / reconcile machinery in this PR (the eager path is a follow-on once load measurement justifies the complexity).

`enforceQuota(c, storage, resource, increment)` is the gate. It's a no-op for tenant-less keys (single-tenant self-hosts + platform admin), so the existing instance-wide flow is unaffected. Routes wired: `POST /webhooks` (resource: `webhooks`), `POST /items` (resource: `items`), and — Wave B Part 2 — `POST /blobs` (both `blobs` count and `storage_bytes` sum). The `count(...)` store method computes everything on demand: `COUNT(*)` for count-style resources, `SUM(size)` for `storage_bytes`. Eager-increment + reconcile is filed as a follow-on if per-tenant cardinality climbs.

Per-tenant `rate_per_minute_limit` enforcement lives in the rate-limit middleware (Wave B Part 2) — applied as a second window on top of the existing per-credential cap. A noisy single credential is bounded by the credential cap; a tenant's collective fleet is bounded by the tenant cap. The middleware caches each tenant's ceiling in-process for 60s to avoid a DB roundtrip per request; tenant-cap changes take up to 60s to propagate. Skipped for tenant-less keys.

Admin surface: `GET /tenants/:id/quotas` and `PUT /tenants/:id/quotas` (platform-admin only). Workspace_admin's read-own surface (`GET /tenants/me/quotas`) lands separately.

Errors: `quota_exceeded` (HTTP 429) with `details: { resource, limit, current }` so SDK / CLI / operator alerts can wire off the shape.

## Blob storage tenant scoping (T-049)

The `blobs` metadata table has a composite PK on `(tenant_id, hash)`. Different tenants uploading the same hash bytes get separate metadata rows; the storage backend (filesystem / S3) still keys by hash globally so the physical file is shared (content-addressed deduplication preserved). `tenant_id` is `NOT NULL DEFAULT ''` — empty string is the sentinel for instance-wide / single-tenant / platform-admin uploads, used to keep the composite PK clean across both dialects.

`storage.blobs.{register, get, remove}` take an explicit `tenantId` parameter; the route layer threads `key.tenant_id ?? ""` so platform-admin uploads on hosted instances and all uploads on single-tenant self-hosts go to the empty-string row. Cross-tenant probes (`GET /blobs/:hash` from a tenant that hasn't uploaded those bytes) return 404. `storage.blobs.removeAllForHash` exists for the platform-admin orphan-cleanup path that nukes a hash from every tenant.

The storage interface's `listAll` / `count` are unscoped by design — admin reconcile + metrics surfaces only.

## Email transport

Pluggable transport for transactional email. Three backends in-tree, picked by `MYME_EMAIL_BACKEND`:

- **`cloudflare`** — Cloudflare Email Service REST API. POSTs `{ from, to, subject, html, text, reply_to }` to `https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send` with `Authorization: Bearer <token>`. Returns `{ ok: true, messageId }` on 2xx (messageId synthesised from the idempotency key — CF doesn't return a native id); `{ ok: false, retryable: false }` on 4xx; `{ ok: false, retryable: true }` on 5xx / 429 / network errors.
- **`smtp`** — `nodemailer`-backed self-host fallback. Idempotency key flows through as an `X-Idempotency-Key` header for MTA-side log correlation (no API-level dedupe). 4xx SMTP codes flag retryable; 5xx don't.
- **`none`** — explicit "unconfigured" backend. Always returns `{ ok: false, error: "email_transport_not_configured", retryable: false }`. Default if `MYME_EMAIL_BACKEND` unset. Surfaces a clean 503 instead of silent dead-lettering.

**Sender-domain guard.** `senderDomainCheck` runs at boot when `MYME_EMAIL_BACKEND=cloudflare`. If `MYME_EMAIL_FROM` doesn't end in `@mail.myme.so` (the verified Cloudflare send domain), the server fails loud at startup. Skipped under `NODE_ENV=test`.

**Idempotency caveat.** Cloudflare Email Service does NOT honour any documented send-time idempotency header. The `idempotencyKey` field on `EmailMessage` flows through to internal audit + log correlation but does not influence the CF send path. A transient retry of the same send can produce duplicate deliveries — acceptable for the three transactional flows wired today (each ships a single-use token; second send is semantically harmless).

**Suppression handling.** Cloudflare maintains its own internal hard-bounce suppression list across the account. Sends to a suppressed address return a 4xx from CF; the server surfaces it through structured logs and returns `{ ok: false, retryable: false }` to the caller. **No server-side `email_suppressions` table.** The prior backend's webhook → table → pre-send-check chain was removed in T-107; CF's internal list replaces it.

**Privacy posture for send-time logs.** On non-2xx the transport logs HTTP status, CF error code + message, recipient _domain_ only (e.g. `gmail.com`), backend identifier, and the message's `tags`. It never logs: full recipient address, email body (html / text), subject line, or idempotency-key contents. The prior backend kept structured per-recipient suppression records server-side; with that surface removed, server logs must not introduce a parallel PII trail through the back door.

**Historical audit data.** The `email.suppressed` audit action existed under the prior backend and may appear in historical audit data; not emitted by the current backend.

## Email verification on sign-up (Wave C PR2)

Every new sign-up gets `auth_user.email_verified = false` and the better-auth instance carries `emailAndPassword.requireEmailVerification: true`, so password sign-in is blocked until the user clicks the verification link.

- **Hook.** `emailVerification.sendOnSignUp: true` + the `sendVerificationEmail` callback wired to the rich transport (HTML template at `auth/email-templates/verify-email.ts`, idempotency key per `(user_id, token)` for log correlation). Token TTL: 3600s (1h, set via `emailVerification.expiresIn`).
- **Sign-up wrapper.** `POST /auth/sign-up` detects the verification-required path by the absence of a Set-Cookie on better-auth's response (which `shouldSkipAutoSignIn` produces when `requireEmailVerification` is on) and 302s to `/auth/verify-email?email=…&return_to=…` instead of `return_to`.
- **Verify-email page.** `GET /auth/verify-email` renders one of four states: `pending` (no token, just-redirected after sign-up), `success` (token validated), `failure` (expired / invalid / unknown — falls back to a resend form), `resent` (after a successful resend). Uses the shared auth-page layout from PR4.
- **Resend.** `POST /auth/verify-email/resend` calls better-auth's `POST /auth/send-verification-email` and redirects back with `?sent=1` regardless of whether the address actually exists, to avoid email enumeration.
- **Grandfather.** Migration `0042_grandfather_email_verified.sql` (PG) / `0035_…` (SQLite) flips `email_verified=true` for every account created before the PR landed. Fresh DBs match zero rows; the migration is a no-op there.
- **Tests.** `markEmailVerified(storage, email)` in `src/test-utils.ts` is the test-side stand-in for clicking the verify link — direct `UPDATE auth_user SET email_verified = TRUE WHERE LOWER(email) = ?`. Use it between sign-up and sign-in in any test that needs an authenticated session post-PR2.

## Forgot-password + reset (Wave C PR3 / T-033)

End-user surface for resetting a forgotten password. Sits on top of better-auth's `request-password-reset` + `reset-password` endpoints, but the email URL bypasses better-auth's intermediate validate-and-redirect GET — our hook constructs a URL pointing at our themed `/auth/reset-password` page directly. Token validation happens on POST.

- **Routes.** `GET /auth/forgot-password` (email form), `POST /auth/forgot-password` (soft-fail dispatch), `GET /auth/reset-password?token=…` (renders the new-password form), `POST /auth/reset-password` (validates fields, dispatches to better-auth, renders success/failure).
- **Hook.** `emailAndPassword.sendResetPassword` builds an in-house URL (`${baseURL}/auth/reset-password?token=…`) and routes the email through the rich Myme transport (idempotency key per `(user_id, token)` for log correlation). Conditional on a real backend — same gate pattern as PR2's verification flow.
- **Token TTL.** `resetPasswordTokenExpiresIn: 3600` (1 hour). Single-use — better-auth deletes the verification row on successful reset.
- **Session revocation.** `revokeSessionsOnPasswordReset: true` — every other session for the user is dropped on a successful reset. The user must re-sign-in everywhere.
- **Per-email throttle.** `auth/per-email-throttle.ts` mints `PerEmailThrottle` instances. The forgot-password router holds one (3/hour per email, in-memory). Layered on top of the per-IP `pathLimits` cap (`/auth/forgot-password: 30`) in `middleware/rate-limit.ts`.
- **No-enumeration invariant.** `POST /auth/forgot-password` always 302s with `?sent=1` regardless of whether the address exists, whether the upstream succeeded, or whether the email transport actually delivered. Better-auth's `request-password-reset` endpoint enforces the same shape upstream (timing-safe). The throttle path is the only branch that surfaces a different state (`?error=rate_limited`) — and it does so based on the email itself, not on whether the account exists, so no enumeration leaks there either.
- **Multi-instance.** Throttle is in-memory only. Multi-instance deployments need a shared counter (Redis); deferred until hosted-multi-tenant lights up.
- **Tests.** `password-reset.test.ts` exercises the full sign-up → forgot → DB-token-read → reset → sign-in round-trip (plus single-use replay rejection + session revocation). `readLatestResetToken(storage)` in `test-utils.ts` reads the most recent `auth_verification` row — used by the integration test in lieu of intercepting the email transport.

## Auth audit-row hardening (Wave C PR8)

Every auth-side wrapper writes a stable-shape audit row through `storage.audit.log`. The shape across actions is uniform — `{ action, resource_type, resource_id, client_ip, details }` — so an operator querying `audit_log` can correlate auth events without matching ad-hoc field names.

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
| `auth.account.delete_requested`                    | `POST /auth/account/delete` success — user initiates account deletion                                                                                           | `auth_user_id`                                | (none — T-139: no email PII)                                       |
| `auth.account.delete_confirmed`                    | `GET /auth/account/delete/confirm?token=…` success — user clicks the confirm link                                                                               | `auth_user_id`                                | (none — T-139)                                                     |
| `auth.account.delete_cancelled`                    | Cancel route (POST `/auth/account/delete/cancel` or GET `/auth/account/cancel`) where `cancelPendingDeletion` matched a row                                     | `auth_user_id`                                | `{ source: "session" \| "link" }`                                  |
| `auth.account.cancel_attempted_but_already_purged` | Cancel route reached but `cancelPendingDeletion` matched zero rows (T-141 — cascade won the race)                                                               | `auth_user_id`                                | `{ source: "session" \| "link" }`                                  |
| `auth.account.sign_in_blocked_pending_deletion`    | Deletion-guard middleware (T-137) intercepts a sign-in attempt against a pending-deletion account                                                               | `auth_user_id`                                | (none — T-139)                                                     |
| `auth.account.hard_deleted`                        | `deleteAccountCascade` transaction commits hard-delete (emitted from `storage/{pg,sqlite}/account-cascade.ts`; survives the post-cascade `redactForUser` sweep) | `auth_user_id`                                | `{ tenant_id, redacted: false }`                                   |
| `auth.grant.created`                               | Code-flow: `POST /auth/authorize/decision` accept. Device-flow: `POST /auth/device/consent` approve (T-131 — both consent surfaces emit)                        | client_id                                     | `{ client_id, user_id, scopes, grant_item_id, source?, created? }` |
| `auth.grant.revoked`                               | `DELETE /auth/grants/:id` and `POST /auth/grants/:id/revoke` (T-131)                                                                                            | client_id                                     | `{ client_id, user_id, grant_item_id }`                            |

**Emission sources.** Most rows are written by route wrappers (`routes/auth-account.ts`, `routes/oauth.ts`). Two come from elsewhere by design: `auth.account.sign_in_blocked_pending_deletion` from `middleware/account-deletion-guard.ts` (the sign-in interception sits in middleware to be path-agnostic across better-auth's various sign-in endpoints), and `auth.account.hard_deleted` from `storage/{pg,sqlite}/account-cascade.ts` (must be inside the cascade transaction so the row is committed atomically with the deletion and survives the same-transaction `redactForUser` sweep that nukes every other audit row referencing the user).

The `auth.account.cancel_attempted_but_already_purged` row exists for honesty in the operator trail. The POST cancel pre-checks `getAccountLifecycle` and short-circuits to 400 `not_pending_deletion` on the normal "already active" / "already gone" case, but a TOCTOU window remains between that read and the `cancelPendingDeletion` UPDATE. When the cascade commits inside that window (or — for the GET-by-link path, which has no pre-check — at any point before the UPDATE), the UPDATE matches zero rows. The route renders the honest page / response and writes this audit action instead of the standard `auth.account.delete_cancelled` row that would lie about a cancel that never happened.

Calls are fire-and-forget (`void storage.audit.log(...)`) — audit failures must never block the user-facing flow. `client_ip` threads through `c.var.clientIp` (T-027 client-ip middleware). The one exception is `auth.account.hard_deleted`, which is `await`-ed inside the cascade transaction so the row commits atomically.

**T-131 emit-site notes.** Both `auth.grant.*` rows emit from explicit Myme route handlers, not from the @better-auth/oauth-provider plugin's `hooks.after` matchers. The hooks fire AFTER the plugin's catch-all completes but with limited body context — `/oauth2/consent` reads `client_id` from the signed `oauth_query`, and `/oauth2/revoke` carries a token-in-hand rather than `(client_id, user_id)`. The explicit Myme handlers have those values from the request body:

- **Code-flow consent** → `routes/auth-consent.ts` `POST /auth/authorize/decision` (which the consent form posts to, then proxies to the plugin's `/oauth2/consent`)
- **Device-flow consent** → `routes/oauth.ts` `POST /auth/device/consent` approve path; the audit row carries `source: "device"` to distinguish from code-flow + `created: true|false` to distinguish first-consent from re-consent
- **Revoke** → `routes/oauth.ts` `DELETE /auth/grants/:id` + `POST /auth/grants/:id/revoke`

`client_id` + `scopes` for the consent rows are read from the **verified** `oauth_query` (the plugin-signed query string), not from form fields — form values can't widen scopes or swap client identity (T-131 review-sweep F1). The shell plugin's `hooks.before` matcher in `auth/oauth-provider.ts` is reserved for refresh-replay access-token revocation; no projection or audit emit lives in the plugin shell.

## Per-IP rate limits on auth surfaces (Wave C PR8)

`middleware/rate-limit.ts`'s `pathLimits` carry small per-IP caps on every auth-abuse-prone endpoint. The middleware iterates entries in object insertion order and takes the FIRST `path.startsWith(prefix)` match — so more-specific prefixes (`/auth/sign-in/magic-link`) MUST appear before broader siblings (`/auth/sign-in`).

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
| `/auth/token`               | 20  |
| `/keys`                     | 200 |

Per-email throttle on `/auth/forgot-password` (3/hour, in-route, `auth/per-email-throttle.ts`) sits inside the per-IP cap — bot-net protection on the IP layer, account-protection on the email layer. The window is shared (`config.rateLimitWindowMs`, default 60s) — per-path windows would need a middleware refactor; deferred.

## Passkey UI (Wave C PR6 / T-034)

Browser-side WebAuthn ceremony on top of better-auth's passkey plugin.

- **Static asset.** `auth-static/passkey-js.ts` exports `PASSKEY_JS` (string template literal — same bundling pattern as `auth-css.ts`). Served from `GET /auth/static/passkey.js` with `Cache-Control: public, max-age=3600` + strong ETag. Public route, no auth required.
- **Surface.** Exposes `window.MymePasskey.{enroll, signIn, isSupported}`. Pages wire onClick handlers; the script handles base64url ⇄ ArrayBuffer conversion + `RegistrationResponseJSON` / `AuthenticationResponseJSON` shaping for better-auth's `verify-registration` + `verify-authentication` endpoints.
- **Enrol page.** `GET /auth/passkey/enroll` — auth-gated (redirects to `/auth/sign-in?return_to=` when no session). Inline click handler calls `MymePasskey.enroll()`. Hides itself on browsers without `window.PublicKeyCredential` or non-secure-context — fallback paragraph explains the requirement.
- **Sign-in.** `/auth/sign-in` carries a "Use a passkey" button (also hidden when unsupported). Inline handler runs the auth ceremony and `window.location.assign(returnTo)` on success. Browser-side `JSON.stringify(returnTo).replace(/</...)` escape prevents `</script>` breakouts even though `validateReturnTo` already rejects off-origin paths.
- **Capability detection.** Done client-side in JS — no UA sniffing. `isSupported()` checks `window.isSecureContext` + `PublicKeyCredential` + `navigator.credentials.{create,get}`.
- **Tests.** `passkey-enroll-page.test.ts` covers the renderer (link to script, fallback paragraph, escape paths) + the route auth gate. The static-asset route gets ETag + 304 + content-type assertions. The full WebAuthn round-trip is browser-side and exercised in the manual cross-browser walkthrough at end of Wave C (Chrome on macOS Touch ID, Safari on iOS iCloud Keychain, Chrome on Android).

## Re-consent diff (Wave C PR5 / T-032)

When a user OAuth-grants the same client a second time and the requested scopes differ from last time, the consent screen renders a diff instead of the flat read / write split.

- **Lookup.** `GET /auth/authorize` queries `system.connection` items in the consenting user's tenant for an active `app` matching the request's `client_id`. Most-recently-granted wins. The grant's `properties.scopes` literal set is threaded into `renderConsentScreen` as `priorScopes`.
- **Hosted-mode only.** The user → tenant binding lives in `storage.users` (hosted mode). In keys mode there's no per-user tenant — the lookup is skipped and the screen renders flat. Defensible: keys mode is single-user self-host where a re-consent is rare.
- **Pure diff helper.** `routes/consent-diff.ts` exports `computeConsentDiff(prev, next): { kept, added, removed }`. Set difference on opaque scope literals (`<typePattern>:<verb>`); preserves `next`-side ordering, de-duplicates.
- **Rendering.** `consent.ts` switches on `priorScopes`:
  - Three group blocks instead of read/write — `Previously granted` (kept), `New permissions` (added), `No longer requested` (removed). Empty groups are omitted.
  - Removed scopes render as static rows with strikethrough on the literal pill — they're being dropped, not re-granted, so no checkbox.
  - The H1 copy switches from "wants to access your data" to "is requesting updated access to your data".
- **CSS.** `auth.css` adds `.section--kept` / `.section--added` / `.section--removed` modifiers (subtle accent borders + tinted backgrounds) and `.scope-row--removed` (line-through + soft opacity).

## Security page (Wave C PR7 / T-031)

User-facing page at `/auth/security` listing connected apps and active sessions, with revoke buttons.

- **Connected apps section** — `system.connection` items of kind `app` in the user's tenant. Each row: client name (resolved by joining `oauth_clients` in a single batch list), scope chips, granted-at, last-used-at. Revoke button POSTs to `/auth/grants/:id/revoke` (form-friendly counterpart to the existing `DELETE /auth/grants/:id`); on success the page redirects back with `?notice=grant_revoked`.
- **Active sessions section** — better-auth's `GET /auth/list-sessions` output, mapped to `SecurityPageSession` rows. UA is parsed to a friendly device hint (Mac / iPhone / Windows / etc); IP is shown raw. Each row carries a Revoke button POSTing to `/auth/sessions/:id/revoke` — handler looks the session up by id in `list-sessions`, extracts the token, forwards to better-auth's `POST /auth/revoke-session` (token-keyed upstream). The current-session row is tagged "current device" and its Revoke button is disabled (use Sign out everywhere instead).
- **Sign out everywhere** — bottom-of-page button POSTs to `/auth/sessions/sign-out-all`, which forwards to better-auth's `POST /auth/revoke-sessions` (drops every session for this user, including current) and redirects to `/auth/sign-in`.
- **Notice flash** — `?notice=…` query param maps to a banner at the top of the page (`grant_revoked`, `session_revoked`, `session_not_found`, `cannot_revoke_current`, etc). Unknown codes resolve to no banner, not a 500.
- **Auth gate** — all four handlers run through `requireConsentSession` (same gate as `/auth/authorize`). Unauthenticated requests 302 to `/auth/sign-in?return_to=…`.

## Reserved extension namespaces

The metadata layer's `extensions` map is a free-form JSON sidecar keyed by namespace string. A handful of namespaces are **reserved** with constrained write-access semantics:

- **`connection.runtime`** (workstream 2) — verbose per-Connection runtime state for `system.connection` items of kind `integration`: sync cursors, in-flight idempotency keys, recent error tail, retry counters. Writable only by the connector's own credential (the one referenced by `credential_ref` on the Connection); readable by tenant admins and the connector. The runtime executor in workstream 3 is the legitimate writer; in workstream 2 the namespace is reserved but no internal code writes it yet.

Reserved namespaces are documented here so accidental general-purpose use ("just stash some stuff") doesn't conflict with platform semantics. Application-defined extensions should use namespaced keys that don't collide with reserved roots.

## Tests

`pnpm test` from the monorepo root, or `pnpm test:fresh-sqlite` / `pnpm test:pg` for the dialect matrices. Integration tests use `createTestContext()` from `src/test-utils.ts` — boots an in-process app against a `:memory:` SQLite or a throw-away `postgres:17` container.
