# Myme

Typed data layer. This monorepo contains four active workspace packages:

- **@mymehq/types** — JSON schemas for the core type set plus the validate/generate scripts that emit the TypeScript registries (`ALL_TYPES`, `ALL_EDGE_TYPES`). Consumed by `@mymehq/shared`; private (bundled into shared's dist, not published to npm)
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

Drizzle migrations under `packages/server/drizzle/{pg,sqlite}/` are the schema source of truth. Inline DDL in `connection.ts` (the `SCHEMA_SQL` block) exists only as the fresh-DB bootstrap path used by tests (`:memory:` SQLite) and new instances; it mirrors what running `pnpm migrate` from `0000` would produce.

When changing schema:

1. Update the Drizzle schema file(s) (`src/storage/pg/schema.ts` or `src/storage/sqlite/schema.ts`).
2. Generate migrations: `pnpm --filter @mymehq/server run migrate:pg:generate` and `migrate:sqlite:generate`.
3. Review the generated SQL in `drizzle/pg/` and `drizzle/sqlite/`.
4. Mirror the change into the bootstrap `SCHEMA_SQL` block in the corresponding `connection.ts` so fresh databases get it without the migrator.
5. Run standalone migration on existing dbs: `pnpm --filter @mymehq/server run migrate`.

**Two documented exceptions** remain inline because Drizzle Kit cannot express them:

- **SQLite FTS5 virtual table** in `sqlite/connection.ts` — virtual tables aren't part of Drizzle's DSL.
- **Postgres RLS policies** in `pg/connection.ts` — dormant by design today (the table-owner connection bypasses RLS); the policies are pre-installed so a production hosted deployment running as a non-owner role inherits isolation automatically.

Do not add new inline DDL outside those exceptions.

## OpenAPI

Routes use `@hono/zod-openapi` with request/response schemas. The OpenAPI 3.1 spec is generated from the route definitions — not maintained manually. Run `pnpm --silent --filter @mymehq/server generate:openapi > openapi.json` to update the committed spec. The spec endpoint is available at `GET /openapi.json` on a running server.

When adding or modifying routes, use `createRoute()` with Zod schemas for request params, body, and responses. Streaming endpoints (SSE, NDJSON export) and HTML endpoints (OAuth consent) stay as plain Hono routes.

The `openapi-freshness` CI job regenerates and diffs `openapi.json` on every PR; spec drift fails the build with a clear regen instruction.

## Per-route tests

Every new HTTP route added under `packages/server/src/routes/` should ship with at least one smoke test in a sibling `*.test.ts` file (auth gate + happy path are the minimum). PR review enforces. Pre-existing untested routes are not subject to this rule until they're modified.

## Before pushing

Two local-validation paths exist, in increasing thoroughness:

- **Pre-push git hook** — automatic. Runs `typecheck + lint + test:fresh-sqlite + test:pg` on every `git push`. Installed via `git config --local core.hooksPath hooks` which `pnpm install`'s `prepare` step sets automatically. Skippable with `git push --no-verify` for small fixes the author is confident about; not the default flow.
- **`pnpm ci-local`** — explicit. Clean install (`rm -rf node_modules`) + everything the pre-push hook runs + `build + format:check`. The "before opening a PR" gate; mirrors CI exactly. Takes a few minutes.

Both invoke `test:pg`, which boots a throw-away `postgres:17` container on port `55432` and runs the server suite against it. Requires Docker (OrbStack / Docker Desktop / compatible daemon); the script fails loudly with an actionable message if the daemon isn't reachable.

Rationale: PR #7 shipped three classes of regression past a local green check — `SCHEMA_SQL` bootstrap gap (PG-only, local dev had cached columns), dialect-specific boolean coercion (pg vs sqlite), and workspace exclusions (Electric's lint + vitest coverage differed between cached dev deps and CI's fresh install). The dual-dialect + clean-slate local checks close that gap before push.

## Error handling

The base error class is `MymeError` (in `@mymehq/shared`). All structured errors use this class with an `ErrorCode` enum and corresponding HTTP status.

## Type registration

Core types (21 in the active V0 set; `core.message` is kept as a deferred stub in `packages/types/core/` but excluded from the runtime registry) live in `packages/types/core/*.json`. The codegen in `packages/types/scripts/generate.ts` emits `ALL_TYPES` into `generated/type-registry.ts`; shared bundles it at build time via tsup's `noExternal`. Custom types can be registered at runtime via `POST /types` (admin only) and are persisted in the `custom_types` table. Core types cannot be modified or deleted via the API.

Inheritance rule: child types may add new fields but cannot redefine fields declared by any ancestor in their parent chain. Enforced on `POST /types`.

Types may declare an optional `display_hints: { title_field?, body_field? }` block that points generic readers at the canonical title/body fields; hints are inherited from the nearest ancestor when a subtype omits them.

Lifecycle is universal — the metadata-layer `state` axis is `active | archived | trashed`. Types do not declare their own state machines; `SYSTEM_TRANSITIONS` in shared is the authoritative graph.

## Edges (Wave 2 PR 4)

Relationships between items are first-class typed edges, not embedded references. Eight core edge types live as JSON under `packages/types/core/edges/` and seed the in-memory registry at startup: `about`, `parent-of`, `in-thread`, `annotates`, `authored-by`, `derived-from`, `supersedes`, `pinned-to`. Each carries cardinality (`one-to-one` / `one-to-many` / `many-to-one` / `many-to-many`), `cascade_on_delete` (`cascade` / `orphan` / `block`), and source / target type constraints.

**Direction is spec-exact.** For `parent-of` source = parent, target = child. For `in-thread` source = member, target = thread. Every consumer (backfill script, cycle-detection walks, filter SQL, cascade planner) obeys this.

Custom edge types register at runtime via `POST /edges/types` (admin only) and persist in `custom_edge_types`. Core types cannot be redefined. No inheritance in V0 (the NQ-1 resolution).

Atomic writes on `POST /items` accept `edges: { [type]: [target_ids] }`. Edge-only mutations go through `/edges` (create / update-properties-only / delete) or `/items/:id/edges` + `/backrefs` for listings. Single-item reads hydrate edges inline; list reads opt in via `?include=edges`.

Query-language filters use `edge[<type>]=<target_id>` (outbound) and `backref[<type>]=<source_id>` (inbound). Both work on `GET /items` and `/search`.

## Permissions

Credentials carry three permission maps:

- `type_permissions` — `{ "<type_pattern>": "read" | "write" | "none" }`. Pattern supports `*` wildcard and `parent.*` subtree.
- `extension_permissions` — `{ "<namespace>": "read" | "write" }`. Scoped to `/items/:id/extensions/:namespace`.
- `edge_permissions` — `{ "<edge_type>": "read" | "write" }` with `*` wildcard. Enforced via `requireEdgePermission` on `POST /edges`, `PATCH /edges/:id`, `DELETE /edges/:id`, and any `POST /items` carrying an `edges` payload.

Edge mutations dual-gate: the caller needs **both** write on the source item's type AND write on the edge type. Admin keys bypass both.

OAuth scope grammar mirrors these: `<type>:<verb>`, `edge.<type>:<verb>`, `metadata:<verb>`. Scopes parse via `parseScope` in `@mymehq/shared`; the consent UI renders the resolved `typePattern` literally.

**Grandfathering:** migration 0012 backfilled `edge_permissions = {"*":"write"}` onto every non-admin key that had any `type_permissions` at the time — pre-PR-4 keys implicitly had broad edge access through `parent_id` / `thread_id` / `about`, so the upgrade preserves it. New keys default to `{}` (opt-in).

## Webhooks

Outbound webhooks fire on item events (`item.created`, `item.updated`, `item.deleted`, `item.restored`, `item.state_changed`), metadata changes (`metadata.changed`), and edge lifecycle events (`edge.created`, `edge.deleted`). The `WebhookConsumer` runs one subscription per event family and delivers to registered URLs with HMAC-SHA256 signatures plus exponential-backoff retry.

## Code style

- ESM-only: `import`/`export`, never `require()`
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files, per NodeNext resolution)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Named exports only, no default exports

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`
