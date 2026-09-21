# Marfa

A typed data layer for structured personal data: items under custom type schemas, edges between them, content-addressed blobs, full-text search and a live event stream, over one HTTP API on SQLite.

## What is here

| Path                                     | What it is                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`@withmarfa/types`](./packages/types)   | Core type and edge JSON schemas; emits the runtime registries                                                            |
| [`@withmarfa/shared`](./packages/shared) | Wire types, Zod validation schemas, error codes                                                                          |
| [`@withmarfa/server`](./packages/server) | The Hono HTTP server, on SQLite                                                                                          |
| [`@withmarfa/sdk`](./packages/sdk)       | TypeScript HTTP client                                                                                                   |
| [`core/`](./core)                        | The Rust engine every native client embeds: a working copy, a queue, the `marfa` binary, and the Swift and Node bindings |
| [`conformance/`](./conformance)          | The contract: black-box fixtures and the written specification under `conformance/spec/`                                 |
| [`deploy/`](./deploy)                    | The container recipe: the server with Litestream streaming its database to the bucket its blobs are replicated to        |

No manifest here carries a version: every package's `package.json` and every `Cargo.toml` holds the placeholder `0.0.0` (the root `package.json` is the workspace, not a package, and holds none), a release is a tag, and `.github/workflows/release.yml` stamps the tag into every manifest in its own checkout when it builds. `ci/version-fields.test.ts` refuses a pull request that moves a manifest off the placeholder. A package publishes when its `package.json` is not private.

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

`.env.example` carries the variables an instance usually sets, not the full list: `packages/server/src/config.ts` is where the list actually lives. [`deploy/`](./deploy) is how an instance runs with its database and blobs backed up to a bucket, and `pnpm --filter @withmarfa/conformance drill:restore` is the drill that rebuilds one from the bucket alone.

## What is authoritative

The server's behavior is the specification, and `conformance/` is where that behavior is written down and held. Where a document and the server disagree, the server is right and the document is a defect.

- The contract: [`conformance/spec/`](./conformance/spec), with [`coverage.md`](./conformance/spec/coverage.md) naming the fixture behind every published operation.
- The vocabulary: [`GLOSSARY.md`](./GLOSSARY.md).
- Conventions and workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).
- The published HTTP surface: [`openapi.json`](./openapi.json), written by `pnpm generate` from the routes and checked against them in CI.
