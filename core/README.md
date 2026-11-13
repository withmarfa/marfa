# Marfa core

The Rust engine every native Marfa client embeds, and the server and command line built beside it. The engine keeps a local SQLite working copy of a slice of one Marfa server, current from the server's event log. Apps read the copy locally, and write to it through a queue that holds each write until the server answers it.

The contract says what each part does: `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md` for the engine and the command line, and the other chapters for the server.

## Crates

| Crate              | What it is                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| `marfa-core`       | The engine                                                               |
| `marfa-rules`      | The rules a client and the server share                                  |
| `marfa-cli`        | The `marfa` command line                                                 |
| `marfa-server`     | The server                                                               |
| `marfa-enrichment` | Reads text and media facts from files, each in a sandboxed child process |
| `marfa-telemetry`  | The exception event the command line and the server send                 |
| `marfa-acl`        | Checks the folders on the way to a private path                          |
| `marfa-allocator`  | The memory allocator of `marfa` and `marfa-server`                       |
| `bindings/swift`   | The Swift binding, which `withmarfa/marfa-swift` packages                |
| `bindings/node`    | The Node module `@withmarfa/core`                                        |

## Where to read more

- [BINDINGS.md](BINDINGS.md): the API an app uses, through Rust, Swift or Node.
- [marfa-cli/README.md](marfa-cli/README.md) and [marfa-cli/COMMANDS.md](marfa-cli/COMMANDS.md): the command line.
- [TELEMETRY.md](TELEMETRY.md): what the core and the command line record and send.
- [marfa-enrichment/README.md](marfa-enrichment/README.md): how files are read.
- [AGENTS.md](AGENTS.md): how to build, test and change the core.
