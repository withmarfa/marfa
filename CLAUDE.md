# Myme

Typed data layer. This monorepo contains four active workspace packages:

- **@mymehq/types** — JSON schemas for the core type set plus the validate/generate scripts that emit the TypeScript registry (`ALL_TYPES`). Consumed by `@mymehq/shared`; private (bundled into shared's dist, not published to npm)
- **@mymehq/shared** — Wire types, Zod validation schemas, error codes, type registry consumer, ID utilities. The foundation imported by both server and SDK
- **@mymehq/server** — Hono HTTP server exposing the Myme API (private, not published)
- **@mymehq/sdk** — TypeScript HTTP client for consuming the Myme API

A fifth package, **@mymehq/electric** (Electric SQL sync client for local-first apps), lives at `packages/electric/` but is **parked**: excluded from `pnpm-workspace.yaml`, marked deprecated in its `package.json`, and skipped by every CI gate. Code stays on disk for future revival; see `packages/electric/README.md` for rationale and the revival recipe.

Published to npm under the `@mymehq` scope. Version tags (`v1.0.0`) trigger the publish workflow.

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

## Environment variables

Server package (not needed for shared or SDK development):

- `PORT` — server port (default: 8600)
- `STORAGE_DIALECT` — `sqlite` or `pg` (default: sqlite)
- `DATABASE_URL` — Postgres connection string (required when dialect is pg)
- `SQLITE_PATH` — database file path (default: `./data/myme.db`)
- `BLOB_BACKEND` — `filesystem` or `s3` (default: filesystem)
- `BLOB_PATH` — blob storage directory (default: `./data/blobs`)
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — S3 config
- `API_KEY_SALT` — salt for key hashing (required in production)
- `CORS_ORIGINS` — allowed origins, comma-separated
- `AUTH_MODE` — `keys` (default) or `hosted` (multi-tenant with user accounts)
- `RATE_LIMIT_REQUESTS` — requests per minute (default: 1000). Rate limiting is always on
- `RATE_LIMIT_ENABLED` — set to `false` to disable rate limiting entirely
- `ENABLE_HSTS` — `true` to add Strict-Transport-Security header (only behind TLS)
- `AUDIT_RETENTION_DAYS` — audit log retention in days (default: 90)
- `AUDIT_CLEANUP_INTERVAL_MS` — audit cleanup interval in ms (default: 86400000)
- `VERSION_RECENT_DAYS` — version recent window in days (default: 30)
- `VERSION_DAILY_SNAPSHOT_DAYS` — daily thinning window end in days (default: 90)
- `VERSION_WEEKLY_SNAPSHOT_DAYS` — weekly thinning window end in days (default: 365)
- `VERSION_MAX_VERSIONS` — hard cap per item (default: 500)
- `VERSION_THINNING_INTERVAL_MS` — thinning job interval in ms (default: 3600000)
- `ERROR_WEBHOOK_URL` — webhook URL for 500 error notifications (optional, debounced)

## Database migrations

Schema managed via Drizzle Kit (dual-dialect: Postgres + SQLite). Existing databases use inline DDL (CREATE TABLE IF NOT EXISTS) in the connection modules. Drizzle migrations are used for fresh databases and future schema changes.

When changing Drizzle schema files (`src/storage/pg/schema.ts` or `src/storage/sqlite/schema.ts`):

1. Update the Drizzle schema file(s)
2. Generate migrations: `pnpm --filter @mymehq/server run migrate:pg:generate` and `migrate:sqlite:generate`
3. Review the generated SQL in `drizzle/pg/` and `drizzle/sqlite/`
4. Also update the inline DDL in the corresponding `connection.ts` for backward compatibility
5. Run standalone migration: `pnpm --filter @mymehq/server run migrate`

SQLite FTS5 virtual table stays in `connection.ts` (Drizzle Kit cannot express virtual tables).

## OpenAPI

Routes use `@hono/zod-openapi` with request/response schemas. The OpenAPI 3.1 spec is generated from the route definitions — not maintained manually. Run `pnpm generate:openapi` to output the spec. The spec endpoint is available at `GET /openapi.json` on a running server.

When adding or modifying routes, use `createRoute()` with Zod schemas for request params, body, and responses. Streaming endpoints (SSE, NDJSON export) and HTML endpoints (OAuth consent) stay as plain Hono routes.

## Error handling

The base error class is `MymeError` (in `@mymehq/shared`). All structured errors use this class with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Core types (21 in the active V0 set; `core.message` is kept as a deferred stub in `packages/types/core/` but excluded from the runtime registry) live in `packages/types/core/*.json`. The codegen in `packages/types/scripts/generate.ts` emits `ALL_TYPES` into `generated/type-registry.ts`; shared bundles it at build time via tsup's `noExternal`. Custom types can be registered at runtime via `POST /types` (admin only) and are persisted in the `custom_types` table. Core types cannot be modified or deleted via the API.

Inheritance rule: child types may add new fields but cannot redefine fields declared by any ancestor in their parent chain. Enforced on `POST /types`.

Types may declare an optional `display_hints: { title_field?, body_field? }` block that points generic readers at the canonical title/body fields; hints are inherited from the nearest ancestor when a subtype omits them.

Lifecycle is universal — the metadata-layer `state` axis is `active | archived | trashed`. Types do not declare their own state machines; `SYSTEM_TRANSITIONS` in shared is the authoritative graph.

## Webhooks

Outbound webhooks fire on item events (created, updated, deleted, restored, transitioned). The `WebhookConsumer` subscribes to the pub/sub system and delivers to registered URLs with HMAC-SHA256 signatures, retry with exponential backoff.

## Code style

- ESM-only: `import`/`export`, never `require()`
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files, per NodeNext resolution)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Named exports only, no default exports

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`
