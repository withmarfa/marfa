# Marfa

A typed data layer for structured personal data. Store, query, and sync items with custom type schemas, content-addressed blob storage, full-text search, and real-time events.

## Packages

| Package                                                | Description                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [`@withmarfa/types`](./packages/types)                 | Core type + edge JSON schemas; emits the runtime registries |
| [`@withmarfa/shared`](./packages/shared)               | Wire types, Zod validation schemas, error codes             |
| [`@withmarfa/server`](./packages/server)               | Hono HTTP server with SQLite and Postgres support           |
| [`@withmarfa/sdk`](./packages/sdk)                     | TypeScript HTTP client                                      |
| [`@withmarfa/webhooks`](./packages/webhooks)           | Inbound-webhook signature verification (Web Crypto only)    |
| [`@withmarfa/runtime-sdk`](./packages/runtime-sdk)     | SDK consumed by integrations                                |
| [`@withmarfa/runtime-test`](./packages/runtime-test)   | Test harness mirroring `runtime-sdk`                        |
| [`@withmarfa/sync-manifest`](./packages/sync-manifest) | The manifest the sync client installs against               |

`@withmarfa/shared`, `@withmarfa/sdk`, `@withmarfa/webhooks`, `@withmarfa/runtime-sdk` and `@withmarfa/runtime-test` publish to npm; the rest stay private.

## Quick start

```bash
git clone https://github.com/withmarfa/marfa.git
cd marfa
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
- Self-hosting and deployment: <https://docs.marfa.so/self-hosting>
- Product docs and guides: <https://docs.marfa.so>

## License

[MIT](./LICENSE)
