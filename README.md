# Marfa

A typed data layer for structured personal data: items under custom type schemas, edges between them, content-addressed blobs, full-text search and a live event stream, over one HTTP API on SQLite.

## What is here

| Path                                     | What it is                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`@withmarfa/types`](./packages/types)   | Core type and edge JSON schemas; emits the runtime registries                                                            |
| [`@withmarfa/shared`](./packages/shared) | Wire types, Zod validation schemas, error codes                                                                          |
| [`@withmarfa/server`](./packages/server) | The Hono HTTP server, on SQLite                                                                                          |
| [`@withmarfa/client`](./packages/client) | The TypeScript client, generated from `openapi.json`                                                                     |
| [`core/`](./core)                        | The Rust engine every native client embeds: a working copy, a queue, the `marfa` binary, and the Swift and Node bindings |
| [`conformance/`](./conformance)          | The contract: black-box fixtures and the written specification under `conformance/spec/`                                 |
| [`deploy/`](./deploy)                    | The container recipe: the server with Litestream streaming its database to the bucket its blobs are replicated to        |

A release is a git tag, each the previous plus 0.0.1. `.github/workflows/release.yml` stamps it into every manifest, which otherwise carries `0.0.0`, then builds the `marfa` binary, `@withmarfa/core`, `@withmarfa/client` and the `marfa-client` crate, publishes them and attaches them to a GitHub release. The Swift package lives in [`withmarfa/marfa-swift`](https://github.com/withmarfa/marfa-swift).

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

Until the instance holds a credential, the server logs a one-time bootstrap secret at every boot. In a second terminal, build `marfa` and use the secret to mint the first key:

```bash
cargo install --locked --path core/marfa-cli
export MARFA_API_URL=http://localhost:8600
marfa keys bootstrap          # paste the secret from the server's log, then press Enter
```

The command prints the operator key. The operator key mints and revokes keys and is the instance's recovery root, so keep it somewhere safe. It reaches no type, so it is not a working key. Use it to mint a working key, then keep the working key in the keychain:

```bash
read -rs MARFA_API_KEY && export MARFA_API_KEY    # paste the operator key
marfa status                  # the server, the instance and its health; the counts need a working key
marfa keys create --label laptop --source laptop
unset MARFA_API_KEY
marfa keys keep               # paste the working key that keys create printed
marfa status                  # now with the item counts
```

On a system with no keychain, set `MARFA_API_KEY` to the working key and skip `marfa keys keep`.

`.env.example` lists every setting the server reads; the settings schema in `packages/server/src/config.ts` defines each one's type, bounds and default, and the server refuses to start on a value outside them. [`deploy/`](./deploy) is how an instance runs with its database and blobs backed up to a bucket, and `pnpm --filter @withmarfa/conformance drill:restore` is the drill that rebuilds one from the bucket alone.

## What is authoritative

The server's behavior is the specification, and `conformance/` is where that behavior is written down and held. Where a document and the server disagree, the server is right and the document is a defect.

- The contract: [`conformance/spec/`](./conformance/spec), with [`coverage.md`](./conformance/spec/coverage.md) naming the fixture behind every published operation.
- The vocabulary: [`GLOSSARY.md`](./GLOSSARY.md).
- Conventions and workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).
- The published HTTP surface: [`openapi.json`](./openapi.json), written by `pnpm generate` from the routes and checked against them in CI.
