# Myme

Typed data layer. This monorepo contains three packages:

- **@mymehq/shared** — Protocol types, Zod validation schemas, error codes, ID utilities. The foundation imported by both server and SDK
- **@mymehq/server** — Hono HTTP server exposing the Myme API (private, not published)
- **@mymehq/sdk** — TypeScript HTTP client for consuming the Myme API

Published to GitHub Packages under the `@mymehq` scope. Version tags (`v0.1.0`) trigger the publish workflow.

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

## Code style

- ESM-only: `import`/`export`, never `require()`
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files, per NodeNext resolution)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Named exports only, no default exports

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`
