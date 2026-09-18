# Marfa

A typed data layer for structured personal data. Store, query, and sync items with custom type schemas, content-addressed blob storage, full-text search, and real-time events.

## Packages

| Package                                  | Description                                                 |
| ---------------------------------------- | ----------------------------------------------------------- |
| [`@withmarfa/types`](./packages/types)   | Core type + edge JSON schemas; emits the runtime registries |
| [`@withmarfa/shared`](./packages/shared) | Wire types, Zod validation schemas, error codes             |
| [`@withmarfa/server`](./packages/server) | Hono HTTP server on SQLite                                  |
| [`@withmarfa/sdk`](./packages/sdk)       | TypeScript HTTP client                                      |

`@withmarfa/shared` and `@withmarfa/sdk` publish to npm; the rest stay private.

[`conformance/`](./conformance) is the contract the server is held to: black-box fixtures driven over HTTP, and the written specification under `conformance/spec/`.

## Quick start

```bash
git clone https://github.com/withmarfa/marfa.git
cd marfa
pnpm install
pnpm test
```

Run the server locally:

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
