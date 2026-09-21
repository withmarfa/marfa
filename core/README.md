# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a declared slice (a type list and a tier) of one Marfa server, hydrated over HTTP, kept current from the event log, queried locally, and written to through a queue that holds every write until the server answers it.

What it does is written down in `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md`, and the fixtures under `conformance/src/suites/device/` gate the binary against them.

- `marfa-core`: the library.
- `marfa-cli`: the `marfa` binary.
- `bindings/swift`: UniFFI bindings packaged as an XCFramework and a Swift package, with an example target. Its own cargo workspace, for the reason `Cargo.toml` gives.
- `bindings/node`: a napi-rs module with a proof script.
- `scripts`: boot a server, mint a key, seed items, for the live lane below.

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
