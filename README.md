# Myme

A typed data layer for structured personal data. Store, query, and sync items with custom type schemas, content-addressed blob storage, full-text search, and real-time events.

## Packages

| Package | Description |
| --- | --- |
| [`@mymehq/shared`](./packages/shared) | Protocol types, Zod validation schemas, error codes |
| [`@mymehq/server`](./packages/server) | Hono HTTP server with SQLite and Postgres support |
| [`@mymehq/sdk`](./packages/sdk) | TypeScript HTTP client |
| [`@mymehq/electric`](./packages/electric) | Electric SQL sync client (experimental) |

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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide.

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

# Restart and verify persistence
docker compose restart server
curl http://localhost:8600/items -H "Authorization: Bearer <your-key>"
```

### Clean up

```bash
docker compose down      # Stop containers (data persists in volumes)
docker compose down -v   # Stop and delete all data
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment to a server.

## License

[MIT](./LICENSE)
