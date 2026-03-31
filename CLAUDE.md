# Myme

Typed data layer. This monorepo contains three packages:

- **@myme/shared** — Protocol types, Zod validation schemas, error codes, ID utilities. The foundation imported by both server and SDK
- **@myme/server** — Hono HTTP server exposing the Myme API
- **@myme/sdk** — TypeScript HTTP client for consuming the Myme API

## Tech stack

- TypeScript 6 (strict mode, ESM-only, NodeNext module resolution)
- pnpm workspaces for monorepo management
- Vitest for testing
- Zod for runtime validation
- Hono for HTTP server (server package)
- Drizzle ORM with better-sqlite3 (server package). Postgres added later

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

- `PORT` — server port (default: 8200)
- `SQLITE_PATH` — database file path (default: `./data/myme.db`)
- `BLOB_PATH` — blob storage directory (default: `./data/blobs`)
- `API_KEY_SALT` — salt for key hashing (required in production)
- `CORS_ORIGINS` — allowed origins, comma-separated

## Code style

- **American English** in all code, comments, documentation, and user-facing strings
- ESM-only: `import`/`export`, never `require()`
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files, per NodeNext resolution)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Named exports only, no default exports

## Testing

- Co-located `.test.ts` files alongside source
- Test behavior, not implementation details
- Integration tests over unit tests where possible
- Descriptive test names: `it("returns error when item ID is invalid")`
- No mocking unless absolutely necessary

## Commits

Conventional Commits with package scope:

```
feat(shared): add type registry with validation
fix(server): handle missing auth header
test(sdk): add conflict resolution tests
```
