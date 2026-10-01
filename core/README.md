# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a declared slice (a type list and a tier) of one Marfa server, hydrated over HTTP, kept current from the event log, queried locally, and written to through a queue that holds every write until the server answers it.

What it does is written down in `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md`, and the fixtures under `conformance/src/suites/device/` gate the binary against them.

- `marfa-core`: the library. `src/contract.rs`, the contract version it was built for, is written from `openapi.json` by `pnpm generate` (`scripts/generate-core-contract.ts`) and never edited by hand; the core keeps its own transport rather than `marfa-client`, so it takes the number there rather than from that crate.
- `marfa-client`: the Rust client, generated from `openapi.json` by OpenAPI Generator under `pnpm generate` and never edited by hand. `openapitools.json` pins the generator and its settings, and `templates/lib.mustache` adds the `CONTRACT_VERSION` the crate was generated for. The generator is a Java program, so `pnpm generate` needs a Java runtime on the path, 11 or later; CI's freshness job installs Temurin 21.
- `marfa-cli`: the `marfa` binary.
- `bindings/swift`: the UniFFI crate, and the script that packages it as an XCFramework and its Swift glue for `withmarfa/marfa-swift`. Its own cargo workspace, for the reason `Cargo.toml` gives.
- `bindings/node`: a napi-rs module with a proof script.
- `scripts`: boot a server, mint a key, seed items, for the live lane below.

## The binary

`marfa` is the reference client of one instance: every operation `openapi.json` publishes is a command, and `marfa operations` prints the table that maps them (the crate's own test holds it against the document). One root per area of the API, each leaf one operation, but `status`, which reads the root, the health door and the item counts together: `status`, `items`, `edges`, `edge-types`, `types`, `search`, `metadata`, `extensions`, `blobs`, `keys`, `config`, `export`, `restore`, `webhooks`, `audit`, `events`, `housekeeping`, `connectors`, `owner`, `login`. `whoami` reads the root as `status` does, and names the credential. Two roots reach no published operation and are commands all the same: `logout` for the keychain and `operations` for the table above. A command builds the request from its arguments, sends it through `marfa-client`'s configuration and client, and prints the server's answer as it came: nothing mirrors the document's schemas in the binary. Every answer names its contract version in `X-Marfa-Contract`, and the binary refuses one on another contract, or a success naming none, with `contract_mismatch` (`device.md` 39).

The server is `--url` on any command, then `MARFA_API_URL`, then the server a kept credential made current; the credential is `--key`, then `MARFA_API_KEY`, then the operating system's keychain, where `marfa keys keep` puts a key, `marfa login` puts a token set, and `marfa keys forget` and `marfa logout` take them out. Never a plain file. A system with no keychain is told so and pointed at the flag, the environment, or `login --print-token`. With `MARFA_API_URL` and `MARFA_API_KEY` both set, a command reads and writes no keychain, but for the keychain's own commands (`keys keep` and `keys forget`, `login` and `logout`), which is how an agent runs the binary: the values come into the environment from the secret store, never from a file here.

`MARFA_KEYCHAIN` names a keychain file to keep in instead of the person's, on macOS, for a run nobody is watching: with it the binary refuses every keychain prompt, so a call that would ask a person fails instead: `no_keychain`, exit 4, for the keychain's own commands, and a keychain that holds nothing for the rest. The crate's tests keep in a keychain file of their own, the end-to-end tests and the conformance suites hand the binary one through `MARFA_KEYCHAIN` (off macOS, where a named keychain is refused, those runs keep nothing), and CI fails a crate test run, or a conformance run on macOS, that changed the login keychain's `marfa` entries (`scripts/login-keychain-unchanged.sh`). A keychain made for a run is never named `login`: macOS adds a file of that name to the person's search list when it is made.

`marfa owner create --email ADDRESS` makes the one account behind the sign-in surface, on the operator key, asking for the password on the terminal or reading it from stdin with `--password-stdin`; `marfa owner show` says who. `marfa login` signs in as that owner with a device code: the binary reads the server's discovery document and refuses one whose issuer or doors are not on the origin it was read from, registers itself as a public client once per server (the client id is kept in the keychain apart from any token, so a sign-out does not lose it; `--client-id` carries it where there is no keychain), asks for everything an owner can hold (every type and edge type either way, metadata, the seven permissions, the identity claims and a refresh token), narrowed to what the server's discovery document says it supports, unless `--scope` narrows it further, prints the code and the page to approve it on (and opens the page unless `--no-browser`), and polls until the owner approves or the code expires. The token set is kept in the keychain and refreshed under a lock before it expires and once after a `401`, because two processes refreshing one token in the same second would replay a rotated refresh token and sign each other out. A refresh the server refuses as a dead grant ends the sign-in: that command says so with exit 5, the token is gone, and every command after it is refused for want of a credential until `marfa login` runs again. `marfa logout` revokes the token and forgets it.

`device` and `folders` take the credential when the command starts (a stale token is refreshed then) and refresh it the same way: a call the server refuses with a `401` under a kept token is refreshed under the same lock and sent again once, so a hydration, a push or a watch that outlives its access token goes on. A key is never refreshed, and a `401` to one is the answer.

`marfa device --db PATH <command>` is the working copy: `hydrate`, `catch-up`, `follow`, `changes`, `status`, `items`, `search`, `edges`, `tags`, `metadata`, `extensions`, `blobs`, `queue`, `drain`, `forget`, `release`, `withdraw`, `pin` and `unpin`, on the store `--db` (or `MARFA_DB`) names. `hydrate --edge-type` holds every edge of a type the key reads, whichever ends the copy holds, and `pin` holds one row by id whatever the slice says of it, kept current after it leaves the slice (`device.md` 1). A blob's bytes are fetched when asked for and kept beside it, in a folder named for its file with `.blobs` after it. That folder is a cache of at most 512 MiB (`CACHE_MOST` in `marfa-core/src/blob.rs`): past it, the writer takes away the bytes read longest ago, never bytes an upload the server has not taken still names, and bytes taken away are fetched again when next asked for. A folder keeps no copy there of bytes it holds as a file. `follow` holds the event stream open and prints a line for each event that changes the copy. `--reader` opens a store another process writes, to read it only: it never takes the writer role, makes a store or writes to one. `changes` always opens that way and prints a line each time the writer saves. It holds every answer to the contract the core was built for as the direct commands do, and a drain that meets another ends there (`device.md` 42). There is no default store, and only `hydrate` and `status` make one at a path where none is: every other command refuses such a path with `no_store`, exit 2, so a mistyped path is never answered from an empty store made for it. `marfa folders <command>` is a folder, which carries its own store. Both take the server and the credential the same way the direct commands do.

`--json` on any command prints the answer as JSON and a refusal as one JSON object on stderr, `{"error":{"code","message","server":{"status","code","details"}|null,"retry_after_seconds"},"exit":N}`, where `error.code` is from the closed set `marfa --help` lists. A command line the binary does not take is a refusal like any other: under `--json` it is the envelope with the code `usage` and exit 2, and without it the usage text. The exit code is one of six:

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                     |
| 1    | The request was refused, by the server, by the binary before sending, or for an answer on another contract; a retry does not change it. |
| 2    | The command line was wrong, or named no store or server.                                                  |
| 3    | The environment failed: unreachable, timed out, a 5xx, a 429. Try again; `retry_after_seconds` says when. |
| 4    | The working copy or the queue refused under the device rules, or this system has no keychain.             |
| 5    | No credential, the credential was refused, or the sign-in ended; `marfa login` starts one.               |

The device fixtures drive the binary through `conformance/src/device/cli-adapter.ts`, which reads the envelope.

## Build

Three commands, which `Core checks` in `ci.yml` runs on every pull request:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --exclude marfa-client --all-targets --no-deps -- -D warnings
cargo nextest run --locked --workspace --exclude marfa-client
```

and again in `bindings/swift`, its own workspace, as plain `cargo fmt --check`,
`cargo clippy --locked --all-targets -- -D warnings` and `cargo nextest run --locked`.
The generated `marfa-client` is held to its generator rather than to clippy or
the tests; formatting takes it too, since the generator formats what it writes.

The tests run under [cargo-nextest](https://nexte.st), which kills a test still
running after the budget in `.config/nextest.toml`. Every test binary, under
nextest or `cargo test`, also runs through `scripts/test-limits.sh`
(`.cargo/config.toml` names it), which caps the size of any file the binary
writes and the processor time it takes. The kernel holds that cap, so it stops a
runaway test even when the runner that started it is gone.

`core.yml` runs the rest on a change to the core, to the packages the server is
built from, or to the workspace's manifests: a lane against a real server, where
`scripts/server-up.sh` boots one and mints a key and
`cargo nextest run --workspace --exclude marfa-client --run-ignored only` runs the tests
that need one, the Swift FFI crate's release build, and the Node binding's
proof. That is what `scripts` is for.

The device fixtures under `conformance/` drive the built binary and refuse one
older than the source it came from, so build it before running them:

```sh
cargo build -p marfa-cli
```

## Bindings

Both open a store on a file with a server and reach the reads, hydrate and catch-up, a held stream (`follow`, with a listener and a subscription to stop it), every queued write, uploads, attachments and a blob's bytes, the queue, drain, release, withdraw, forget, and the six verdicts as a typed value carrying what each one says. Both also open a store to read (`openReader`) and read its change signal (`dataVersion`). An in-memory store and catch-up's idle setting stay in Rust, where the tests use them.

Swift: `bindings/swift/build.sh` packages the FFI crate with cargo-swift into `bindings/swift/MarfaCore`, with macOS, iOS and simulator slices, and holds every slice to its deployment targets with `check-targets.sh`. `withmarfa/marfa-swift` runs it at the commit it pins; the Swift package, its generated types and its sample live there.

Node: the package sits outside the pnpm workspace, so every pnpm call carries the flag:

```sh
cd bindings/node
pnpm install --ignore-workspace
pnpm --ignore-workspace run build
pnpm --ignore-workspace run check
pnpm --ignore-workspace run test
```

`check` holds the proof script and the tests to the `index.d.ts` the build generates. `test` drives the held stream, the reading open, and a drain whose create names a source its key does not claim, against a server it scripts itself.

`scripts/binding-proof.sh` drives the Node binding, once it is built, through a write made offline and its verdict once the server returns: it hydrates, the server stops, it queues writes and drains into nothing, the server comes back on the same origin with the same data, and it drains again. Then it is told of a note the binary makes while it holds the stream, and reads, from a store of its own, the thumbnails of a type the binary registers.
