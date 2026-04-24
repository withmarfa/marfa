# Myme

A typed data layer for structured personal data. Store, query, and sync items with custom type schemas, content-addressed blob storage, full-text search, and real-time events.

## Packages

| Package                               | Description                                                 |
| ------------------------------------- | ----------------------------------------------------------- |
| [`@mymehq/types`](./packages/types)   | Core type + edge JSON schemas; emits the runtime registries |
| [`@mymehq/shared`](./packages/shared) | Wire types, Zod validation schemas, error codes             |
| [`@mymehq/server`](./packages/server) | Hono HTTP server with SQLite and Postgres support           |
| [`@mymehq/sdk`](./packages/sdk)       | TypeScript HTTP client                                      |

`@mymehq/shared` and `@mymehq/sdk` publish to npm; `@mymehq/types` and `@mymehq/server` stay private.

## Quick start

```bash
git clone https://github.com/mymehq/myme.git
cd myme
pnpm install
pnpm test
```

Run the server locally with SQLite (no Postgres required):

```bash
cd packages/server
pnpm dev    # http://localhost:8600
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide and [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and workflow rules.

## Docker

Start the server with Postgres and S3-compatible storage:

```bash
docker compose up --build
```

The server will be available at `http://localhost:8600`.

### Bootstrap

Create your first API key (no auth required when zero keys exist):

```bash
curl -X POST http://localhost:8600/keys \
  -H "Content-Type: application/json" \
  -d '{"label": "admin"}'
```

### Verify

```bash
# Create an item
curl -X POST http://localhost:8600/items \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"type": "core.note", "properties": {"body": "Hello Docker"}}'

# List items
curl http://localhost:8600/items -H "Authorization: Bearer <your-key>"
```

### Clean up

```bash
docker compose down      # Stop containers (data persists in volumes)
docker compose down -v   # Stop and delete all data
```

## Documentation

- Architecture, conventions, and workflow rules: [`CLAUDE.md`](./CLAUDE.md)
- Contributor guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Production deployment: [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- Product docs and guides: <https://docs.myme.so>

## License

[MIT](./LICENSE)
