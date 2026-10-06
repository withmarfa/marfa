# Marfa

> **Early project.** Marfa is at version 0.0.x. Things will change without notice, and nothing is stable yet. Fuller documentation is on the way.

Marfa is a home for your personal data that you run yourself. You keep your notes, tasks, reading and other records in one place, in a structure you choose, and any app, script or AI agent you trust can use them. As agents take on more of the typing, apps matter more as ways to look at and use your data than as places that hold it, so your data should not live inside one.

- **Your structure.** Define the kinds of things you keep and how they link. Marfa checks everything against them.
- **Open to every app.** Apps from WithMarfa will use the same interface as anything you build.
- **Bring data in.** [Connectors](https://github.com/withmarfa/marfa-connectors) pull in data from other services. GitHub, Todoist and RSS exist today.
- **Use it from anywhere.** A command-line tool, a [TypeScript client](./packages/client) and a [Swift package](https://github.com/withmarfa/marfa-swift), all built on one HTTP API.
- **Open source.** Everything WithMarfa makes is public. If you are interested, open an issue and say hello.

Under the hood, Marfa is a server that keeps everything in a single SQLite file and speaks plain HTTP. There is no database to set up, and the file is easy to copy and back up. You run it on your own machine or in a container.

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

A new instance has no key and no owner, and nobody can sign in until both exist. In a second terminal, make the first key:

```bash
cargo install --locked --path core/marfa-cli
export MARFA_API_URL=http://localhost:8600
marfa keys bootstrap    # paste the bootstrap secret from the server's log, then press Enter
```

The command prints the operator key. Use it to create the owner, then open the sign-in page:

```bash
read -rs MARFA_API_KEY && export MARFA_API_KEY    # paste the operator key
marfa owner create --email owner@example.com      # asks for a password on the terminal
unset MARFA_API_KEY
```

Sign in at <http://localhost:8600/auth/sign-in>. [`CONTRIBUTING.md`](./CONTRIBUTING.md#making-the-first-key) goes on to make a working key and check the instance.

`.env.example` lists every setting the server reads; the settings schema in `packages/server/src/config.ts` defines each one's type, bounds and default, and the server refuses to start on a value outside them. [`deploy/`](./deploy) is how an instance runs with its database and blobs backed up to a bucket, and `pnpm --filter @withmarfa/conformance drill:restore` is the drill that rebuilds one from the bucket alone.

## What is authoritative

The server's behavior is the specification, and `conformance/` is where that behavior is written down and held. Where a document and the server disagree, the server is right and the document is a defect.

- The contract: [`conformance/spec/`](./conformance/spec), with [`coverage.md`](./conformance/spec/coverage.md) naming the fixture behind every published operation.
- The vocabulary: [`GLOSSARY.md`](./GLOSSARY.md).
- Conventions and workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).
- The published HTTP surface: [`openapi.json`](./openapi.json), written by `pnpm generate` from the routes and checked against them in CI.
