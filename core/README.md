# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a declared slice (a type list and a tier) of one Marfa server, hydrated over HTTP, kept current from the event log, queried locally, and written to through a queue that holds every write until the server answers it.

What it does is written down in `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md`, and the fixtures under `conformance/src/suites/device/` gate the binary against them.

- `marfa-core`: the library.
- `marfa-cli`: the `marfa` binary.
- `bindings/swift`: UniFFI bindings packaged as an XCFramework and a Swift package, with an example target. Its own cargo workspace, for the reason `Cargo.toml` gives.
- `bindings/node`: a napi-rs module with a proof script.
- `scripts`: boot a server, mint a key, seed items, for the live lane below.

## The binary

`marfa device --db PATH <command>` is the working copy: `hydrate`, `catch-up`, `status`, `items`, `search`, `edges`, `tags`, `metadata`, `extensions`, `queue`, `drain`, `forget` and `release`, on the store `--db` (or `MARFA_DB`) names. There is no default store. `marfa folders <command>` is a folder, which carries its own store. The server a command sends to is `--url`/`--key` on any command, or `MARFA_API_URL`/`MARFA_API_KEY`.

`--json` on any command prints records as JSON and a refusal as one JSON object on stderr, `{"error":{"code","message","server":{"status","code"}|null,"retry_after_seconds"},"exit":N}`, where `error.code` is from the closed set `marfa --help` lists. The exit code is one of six:

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                     |
| 1    | The request was refused, by the server or by the binary before sending; a retry does not change it.      |
| 2    | The command line was wrong, or named no store or server. clap's own refusals print its usage text.        |
| 3    | The environment failed: unreachable, timed out, a 5xx, a 429. Try again; `retry_after_seconds` says when. |
| 4    | The working copy or the queue refused under the device rules.                                             |
| 5    | No credential, or the credential was refused.                                                             |

The device fixtures drive the binary through `conformance/src/device/cli-adapter.ts`, which reads the envelope.

## Build

Three commands, and `core.yml` runs them here and again in `bindings/swift`,
which is its own workspace and is reached by neither of the first two:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`core.yml` then runs a third lane against a real server: `scripts/server-up.sh`
boots one and mints a key, and `cargo test -p marfa-core -- --include-ignored`
runs the tests that need one. That is what `scripts` is for.

The device fixtures under `conformance/` drive the built binary and refuse one
older than the source it came from, so build it before running them:

```sh
cargo build -p marfa-cli
```

## Bindings

Swift: `bindings/swift/build.sh` packages the FFI crate with cargo-swift into `bindings/swift/MarfaCore`; then `swift run` in `bindings/swift/Example`.

Node: the package sits outside the pnpm workspace, so every pnpm call carries the flag:

```sh
cd bindings/node
pnpm install --ignore-workspace
pnpm --ignore-workspace run build
pnpm --ignore-workspace run proof
```
