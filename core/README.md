# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a declared slice (a type list and a tier) of one Marfa server, hydrated over HTTP, kept current from the event log, queried locally, and written to through a queue that holds every write until the server answers it.

What it does is written down in `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md`, and the fixtures under `conformance/src/suites/device/` gate the binary against them.

- `marfa-core`: the library.
- `marfa-client`: the Rust client, generated from `openapi.json` by OpenAPI Generator under `pnpm generate` and never edited by hand. `openapitools.json` pins the generator and its settings, and `templates/` holds the overrides: `ResponseContent` keeps the response's headers, so a caller can read `Retry-After`, and the crate carries the `CONTRACT_VERSION` it was generated for. The generator is a Java program, so `pnpm generate` needs a Java runtime on the path, 11 or later; CI's freshness job installs Temurin 21.
- `marfa-cli`: the `marfa` binary.
- `bindings/swift`: UniFFI bindings packaged as an XCFramework and a Swift package, with an example target. Its own cargo workspace, for the reason `Cargo.toml` gives.
- `bindings/node`: a napi-rs module with a proof script.
- `scripts`: boot a server, mint a key, seed items, for the live lane below.

## The binary

`marfa` is the reference client of one instance: every operation `openapi.json` publishes is a command, and `marfa operations` prints the table that maps them (the crate's own test holds it against the document). One root per area of the API, each leaf one operation, but `status`, which reads the root, the health door and the item counts together: `status`, `items`, `edges`, `edge-types`, `types`, `search`, `metadata`, `extensions`, `blobs`, `keys`, `config`, `export`, `restore`, `webhooks`, `audit`, `events`, `housekeeping`, `connectors`, `owner`, `login`. `whoami` reads the root as `status` does, and names the credential. Two roots reach no published operation and are commands all the same: `logout` for the keychain and `operations` for the table above. A command builds the request from its arguments, sends it through `marfa-client`'s configuration and client, and prints the server's answer as it came: nothing mirrors the document's schemas in the binary. Every answer names its contract version in `X-Marfa-Contract`, and the binary refuses one on another contract, or a success naming none, with `contract_mismatch` (`device.md` 39).

The server is `--url` on any command, then `MARFA_API_URL`, then the server a kept credential made current; the credential is `--key`, then `MARFA_API_KEY`, then the operating system's keychain, where `marfa keys keep` puts a key, `marfa login` puts a token set, and `marfa keys forget` and `marfa logout` take them out. Never a file. A system with no keychain is told so and pointed at the flag, the environment, or `login --print-token`.

`marfa owner create --email ADDRESS` makes the one account behind the sign-in surface, on the operator key, asking for the password on the terminal or reading it from stdin with `--password-stdin`; `marfa owner show` says who. `marfa login` signs in as that owner with a device code: the binary reads the server's discovery document and refuses one whose issuer or doors are not on the origin it was read from, registers itself as a public client once per server (the client id is kept in the keychain apart from any token, so a sign-out does not lose it; `--client-id` carries it where there is no keychain), asks for everything an owner can hold (every type and edge type either way, metadata, the seven permissions, the identity claims and a refresh token), narrowed to what the server's discovery document says it supports, unless `--scope` narrows it further, prints the code and the page to approve it on (and opens the page unless `--no-browser`), and polls until the owner approves or the code expires. The token set is kept in the keychain and refreshed under a lock before it expires and once after a `401`, because two processes refreshing one token in the same second would replay a rotated refresh token and sign each other out. A refresh the server refuses as a dead grant ends the sign-in: that command says so with exit 5, the token is gone, and every command after it is refused for want of a credential until `marfa login` runs again. `marfa logout` revokes the token and forgets it.

The refresh is the direct commands'. `device` and `folders` take the credential once, when the command starts (a stale token is refreshed then), and a command that outlives the access token ends with a `401`; unattended work runs under a key.

`marfa device --db PATH <command>` is the working copy: `hydrate`, `catch-up`, `status`, `items`, `search`, `edges`, `tags`, `metadata`, `extensions`, `blobs`, `queue`, `drain`, `forget` and `release`, on the store `--db` (or `MARFA_DB`) names. A blob's bytes are fetched when asked for and kept beside it, in a folder named for its file with `.blobs` after it. There is no default store. `marfa folders <command>` is a folder, which carries its own store. Both take the server and the credential the same way the direct commands do.

`--json` on any command prints the answer as JSON and a refusal as one JSON object on stderr, `{"error":{"code","message","server":{"status","code","details"}|null,"retry_after_seconds"},"exit":N}`, where `error.code` is from the closed set `marfa --help` lists. The exit code is one of six:

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                     |
| 1    | The request was refused, by the server or by the binary before sending; a retry does not change it.      |
| 2    | The command line was wrong, or named no store or server. clap's own refusals print its usage text.        |
| 3    | The environment failed: unreachable, timed out, a 5xx, a 429. Try again; `retry_after_seconds` says when. |
| 4    | The working copy or the queue refused under the device rules, or this system has no keychain.             |
| 5    | No credential, the credential was refused, or the sign-in ended; `marfa login` starts one.               |

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

Both open a store on a file with a server and reach the reads, hydrate and catch-up, every queued write, uploads, attachments and a blob's bytes, the queue, drain, release, forget, and the six verdicts as a typed value carrying what each one says. An in-memory store and catch-up's idle setting stay in Rust, where the tests use them.

Swift: `bindings/swift/build.sh` packages the FFI crate with cargo-swift into `bindings/swift/MarfaCore`, with macOS, iOS and simulator slices; the example in `bindings/swift/Example` runs with `swift run`.

Node: the package sits outside the pnpm workspace, so every pnpm call carries the flag:

```sh
cd bindings/node
pnpm install --ignore-workspace
pnpm --ignore-workspace run build
pnpm --ignore-workspace run check
```

`check` holds the proof script to the `index.d.ts` the build generates.

`scripts/binding-proof.sh` drives both, after both are built, through a write made offline and its verdict once the server returns: each hydrates, the server stops, each queues writes and drains into nothing, the server comes back on the same origin with the same data, and each drains again.
