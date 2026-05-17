# Myme

A typed data layer for structured personal data. Store, query, and sync items with custom type schemas, content-addressed blob storage, full-text search, and real-time events.

## Packages

| Package                                                 | Description                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`@mymehq/types`](./packages/types)                     | Core type + edge JSON schemas; emits the runtime registries             |
| [`@mymehq/shared`](./packages/shared)                   | Wire types, Zod validation schemas, error codes                         |
| [`@mymehq/server`](./packages/server)                   | Hono HTTP server with SQLite and Postgres support                       |
| [`@mymehq/sdk`](./packages/sdk)                         | TypeScript HTTP client                                                  |
| [`@mymehq/webhooks`](./packages/webhooks)               | Cross-runtime inbound-webhook signature verification (Web Crypto only)  |
| [`@mymehq/runtime-control`](./packages/runtime-control) | Cloudflare Worker control plane for the hosted integrations substrate   |
| [`@mymehq/runtime-sdk`](./packages/runtime-sdk)         | In-Worker SDK consumed by Integration Workers                           |
| [`@mymehq/runtime-test`](./packages/runtime-test)       | In-Worker test harness mirroring `runtime-sdk`                          |

`@mymehq/shared`, `@mymehq/sdk`, and `@mymehq/webhooks` publish to npm; the rest stay private.

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

## Documentation

- Architecture, conventions, and workflow rules: [`CLAUDE.md`](./CLAUDE.md)
- Contributor guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Production deployment: [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- Product docs and guides: <https://docs.myme.so>

## License

[MIT](./LICENSE)
