# Marfa core

The Rust engine every native client embeds. This is its first, read-only slice: a local SQLite working copy of a declared slice (a type list and a tier) of one Marfa server, hydrated over HTTP, kept current from the event log, and queried locally.

- `marfa-core`: the library.
- `marfa-cli`: the `marfa` binary.
- `bindings/swift`: UniFFI bindings packaged as an XCFramework and a Swift package, with an example target.
- `bindings/node`: a napi-rs module with a proof script.
- `scripts`: boot a server, mint a key, seed items. The only place anything under `core/` writes to a server.

The local schema is provisional; see the comment at the top of `marfa-core/src/schema.sql`.

## Build

```sh
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
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
