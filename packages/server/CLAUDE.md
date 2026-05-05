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

## Per-route enforcement order

Most write routes follow the same gate sequence:

1. Resolve auth (`requireAuth(c)`, `requireAdmin(c)`, or — for metadata-layer mutations — `requireMetadataPermission(c, subresource, level)` which admits admin + scope-bearing credentials).
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

## Reserved extension namespaces

The metadata layer's `extensions` map is a free-form JSON sidecar keyed by namespace string. A handful of namespaces are **reserved** with constrained write-access semantics:

- **`connection.runtime`** (workstream 2) — verbose per-Connection runtime state for `system.connection` items of kind `external-service-connector`: sync cursors, in-flight idempotency keys, recent error tail, retry counters. Writable only by the connector's own credential (the one referenced by `credential_ref` on the Connection); readable by tenant admins and the connector. The runtime executor in workstream 3 is the legitimate writer; in workstream 2 the namespace is reserved but no internal code writes it yet.

Reserved namespaces are documented here so accidental general-purpose use ("just stash some stuff") doesn't conflict with platform semantics. Application-defined extensions should use namespaced keys that don't collide with reserved roots.

## Tests

`pnpm test` from the monorepo root, or `pnpm test:fresh-sqlite` / `pnpm test:pg` for the dialect matrices. Integration tests use `createTestContext()` from `src/test-utils.ts` — boots an in-process app against a `:memory:` SQLite or a throw-away `postgres:17` container.
