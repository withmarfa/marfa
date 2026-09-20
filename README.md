# Marfa

A typed data layer for structured personal data: items under custom type schemas, edges between them, content-addressed blobs, full-text search and a live event stream, over one HTTP API on SQLite.

## What is here

| Path                                     | What it is                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@withmarfa/types`](./packages/types)   | Core type and edge JSON schemas; emits the runtime registries                                                                                             |
| [`@withmarfa/shared`](./packages/shared) | Wire types, Zod validation schemas, error codes                                                                                                           |
| [`@withmarfa/server`](./packages/server) | The Hono HTTP server, on SQLite                                                                                                                           |
| [`@withmarfa/sdk`](./packages/sdk)       | TypeScript HTTP client                                                                                                                                    |
| [`core/`](./core)                        | The Rust engine every native client embeds — a read-only slice today — the `marfa` binary, and the Swift and Node bindings                                |
| [`conformance/`](./conformance)          | The contract: black-box fixtures over HTTP for the server, a scripted server for the device half, and the written specification under `conformance/spec/` |

`@withmarfa/shared` and `@withmarfa/sdk` publish to npm; the rest stay private.

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

`.env.example` is a starter carrying the variables an instance usually sets, not the full list. Most are read in `packages/server/src/config.ts` and threaded through `AppConfig`; a handful — the placement labels, the build sha, the better-auth secret aliases — are read where they are used.

## What is authoritative

The server's behavior is the specification, and `conformance/` is where that behavior is written down and held. Where a document and the server disagree, the server is right and the document is a defect.

- The contract: [`conformance/spec/`](./conformance/spec), with [`coverage.md`](./conformance/spec/coverage.md) naming the fixture behind every published operation.
- The vocabulary: [`GLOSSARY.md`](./GLOSSARY.md) — the words this repository uses, the words it does not, the permission names, the time rule and the error meanings.
- Conventions and workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).
- The published HTTP surface: [`openapi.json`](./openapi.json), generated from the routes and checked against them in CI.
