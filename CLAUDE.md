# Myme

Typed data layer. This monorepo contains four packages:

- **@myme/shared** — Myme types, Zod validation schemas, error codes, type registry, ID utilities. The foundation imported by both server and SDK
- **@myme/server** — Hono HTTP server exposing the Myme API (private, not published)
- **@myme/sdk** — TypeScript HTTP client for consuming the Myme API
- **@myme/electric** — Electric SQL sync client for local-first apps (optional, experimental)

Published to npm under the `@myme` scope. Version tags (`v1.0.0`) trigger the publish workflow.

## Tech stack

- TypeScript 6 (strict mode, ESM-only, NodeNext module resolution)
- pnpm workspaces for monorepo management
- Vitest for testing
- Zod for runtime validation
- Hono for HTTP server (server package)
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
- `ENABLE_GRAPHQL` — `true` to enable the GraphQL endpoint (default: disabled)

## Feature gates

- **GraphQL** (`ENABLE_GRAPHQL=true`) — disabled by default. The REST API and SSE events cover all current use cases. Re-evaluate when third-party apps need complex nested queries. If GraphQL code drifts from REST types or causes maintenance friction, flag it for review.

## Error handling

The base error class is `MymeError` (in `@myme/shared`). All structured errors use this class with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Core types (22, in the `core.*` namespace) are loaded from the codegen registry at startup. Custom types can be registered at runtime via `POST /types` (admin only) and are persisted in the `custom_types` table. Core types cannot be modified or deleted via the API.

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
