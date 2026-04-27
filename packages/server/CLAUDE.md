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

1. Resolve auth (`requireAuth(c)` or `requireAdmin(c)`).
2. Validate body shape (Zod via `createRoute`).
3. Check type permissions (`requireTypeAccess(c, type, "write")`).
4. Resolve enforcement levers (TSC42 §5): tenant config + per-credential override → effective `EnforcementSettings`.
5. Apply source allow-list (reject if violating).
6. Apply strict-mode validation (reject unknown properties when on).
7. Stamp `source`, `origin`, `tier` from credential defaults.
8. Run the storage write inside a transaction.
9. Hydrate the response (edges, metadata) and return.

Read routes apply the source-filter lever in step 4 before issuing the storage query.

## Tests

`pnpm test` from the monorepo root, or `pnpm test:fresh-sqlite` / `pnpm test:pg` for the dialect matrices. Integration tests use `createTestContext()` from `src/test-utils.ts` — boots an in-process app against a `:memory:` SQLite or a throw-away `postgres:17` container.
