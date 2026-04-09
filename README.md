# Myme

Typed data layer — server, SDK, and shared protocol types.

## Packages

| Package                           | Description                             |
| --------------------------------- | --------------------------------------- |
| [@myme/shared](./packages/shared) | Protocol types, validation, error codes |
| [@myme/server](./packages/server) | Hono HTTP server                        |
| [@myme/sdk](./packages/sdk)       | TypeScript HTTP client                  |
| [@myme/electric](./packages/electric) | Electric SQL sync client (experimental) |

## Development

```bash
pnpm install
pnpm test
pnpm build
```

See [CLAUDE.md](./CLAUDE.md) for full development guide.

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
