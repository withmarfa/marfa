# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a slice of one Marfa server, kept current from its event log, read locally, and written to through a queue that holds each write until the server answers it. `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md` say what it does; the fixtures under `conformance/src/suites/device/` hold the `marfa` binary to them.

| Crate            | What it is                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `marfa-core`     | The engine. `src/contract.rs` is written from `openapi.json` by `pnpm generate`                              |
| `marfa-cli`      | The `marfa` binary                                                                                           |
| `bindings/swift` | The UniFFI crate and `build.sh`, which packages it for `withmarfa/marfa-swift`; a cargo workspace of its own |
| `bindings/node`  | The napi-rs module `@withmarfa/core`                                                                         |

## The binary

`marfa --help` lists every command, the exit codes and the `--json` error shape; `marfa operations` maps each published operation to its command. `marfa device --db PATH` is a working copy, and `marfa folders` a folder on disk that carries its own store.

- **Requests:** every command sends through `marfa_core::http::Http`, the stack the working copy uses: it follows no redirect, reads the contract header on every answer, and renews a refused credential once. A command waits up to 90 seconds for an answer to begin and as long again to read it, which a door that works before it answers needs; an upload waits on the server's work, and a streamed answer fails after 45 seconds of silence. The binary writes each path, query name, body key and enum value by hand. `commands/driven.rs` runs each command in this process against a local server that refuses every request but the root, and holds each request a command sends, up to that refusal, to `openapi.json`: the method and path, each query name, each key of a JSON body, and each enum value a flag names. A flag that takes any text leaves its value to the server. A rename in the document fails that test.
- **Server:** `--url`, then `MARFA_API_URL`, then the server a kept credential made current.
- **Credential:** `--key`, then `MARFA_API_KEY`, then the operating system's keychain, where `marfa keys keep` and `marfa login` put one. Never a plain file. With both variables set, a command reads and writes no keychain, which is how an agent runs it.
- **Unattended runs:** `MARFA_KEYCHAIN` names a keychain file to use instead of the person's, on macOS, and refuses every prompt. Tests and CI use it; CI fails a run that changed the login keychain's `marfa` entries.

Refresh, `logout` and `keys forget` coordinate through one private lock per stored server for the operating-system user, independent of `HOME`, `TMPDIR` and `XDG_RUNTIME_DIR`. The lock files contain no credentials and stay under `.marfa-credential-locks` in the home directory recorded by the operating system; leave them in place while commands may be running. An unsafe lock path is refused before reading or changing stored credentials. `keys forget` works offline without refreshing a token. Logout removes the local sign-in and reports whether server revocation succeeded; without a saved revocation endpoint, it reports `revoked: false`.

### Process outcomes

| Exit | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | Completed, including a completed drain containing refused writes                      |
| 1    | Request refused or invalid, including another contract                                |
| 2    | Invalid command line, missing store, or missing server                                |
| 3    | Environmental failure, including network failure, rate limits, and full local storage |
| 4    | Working-copy or queue rule, other store fault, or unavailable credential storage      |
| 5    | Missing or refused credential, or ended sign-in                                       |

`device drain` preserves its complete stdout report when it exits 3 for an unavailable pass or undelivered writes, or 5 for a credential-stopped pass. It prints no second error envelope for these report outcomes. Credential stop takes precedence if both occur. A completed pass with refused writes exits 0 and its plain output separately counts refused verdicts; JSON retains each typed verdict. Held writes alone do not make an environmental failure. A direct renewal error prints its typed error on stderr with empty stdout; earlier answers remain committed and the current queued request, idempotency key, and refusal count stay unchanged. Local renewal failures carry no invented server status. An environmental renewal failure while sending a queued request returns the unavailable report; a renewal failure during a follow-up read can end the call with its typed error.

A copy saves before it has reached a server. `device types declare` takes the types an app saves, as one JSON object or an array, and `device types declared` lists them; until it hydrates the copy checks each write against them and the types Marfa ships, and a hydration registers the ones the instance lacks where the key may, and says which it could not. `hydrate`, `catch-up` and `drain` stop on Ctrl-C and exit 3 with the code `canceled`, leaving the store consistent: a stopped hydration refuses reads, a stopped catch-up keeps its cursor, and a stopped drain leaves unsent writes queued. Each binding takes a `Stop`; the caller raises it when its language's cancellation is requested.

Reading commands on an absent store, including `--reader` and `device changes`, report `no_store` and exit 2. Queue JSON retains dependency history; plain “waiting on” names only unresolved dependencies.

## Build and check

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --no-deps -- -D warnings
cargo nextest run --locked --workspace
cargo build -p marfa-cli   # the device fixtures refuse a binary older than its source
```

Then the same three in `bindings/swift`. Every test binary runs under `scripts/test-limits.sh`, which caps the file size and processor time it can take.

`scripts/server-up.sh` exports `MARFA_TEST_KEY` for ordinary working requests and `MARFA_TEST_OPERATOR_KEY` for operator-only inspection. With `MARFA_SERVER_KEEP`, both keys are kept and returned on restart. A kept directory without its operator key is refused; use a fresh directory. `scripts/server-keys.test.sh` checks both roles against the server on first boot and after restart.

### Which jobs run

Three jobs check the core. `scripts/ci-required.ts` decides from the changed paths which of them a pull request runs. A draft pull request runs none of them; marking it ready for review, and every push after, runs the ones its changes name.

- **`Core checks (Linux)`** (`ci.yml`, Ubuntu) runs the three commands above for the core workspace. It is the only job that lints the credential store used when the operating system is not macOS, and the only one that tests the in-memory test keychain the tests use in its place. A pull request runs it when it changes the core, `openapi.json` or `ci.yml`; a change to the Swift crate alone does not.
- **`Core checks`** (`ci.yml`, macOS) runs the same three commands, with the tests under a check that the login keychain is unchanged, then the three in `bindings/swift`. It keeps the macOS keychain and the Apple builds. A pull request runs it when it changes the core, `openapi.json` or `ci.yml`. Its last step runs `bindings/swift/build.sh`, as `withmarfa/marfa-swift` does, when the change reaches the Swift crate, its lockfile or the script, so a dependency bump that stops the Swift glue from generating fails here.
- **`Core (Rust, bindings, live)`** (`core.yml`, macOS) runs the tests that need a live server (`scripts/server-up.sh` boots one; `--run-ignored only` runs them), builds the Swift crate in release mode for the Apple targets, builds and tests the Node module, and proves the Node binding against a booted server. A pull request runs it when it changes the core, `openapi.json` or `core.yml`. The Node module's JavaScript, test and script files run only here.

A push to `main` runs `ci.yml` in full unless it reaches only the format check and `ci.yml` passed on the commit before it. It runs `core.yml` when it changes the core, `openapi.json`, `core.yml`, or the server and the packages the live tests boot it from. The nightly run and a manual dispatch run every job.

A pull request that changes the server and leaves `openapi.json` alone runs none of the three. A server change that breaks the live tests or the Node binding's proof is therefore found on the push to `main`, not before the merge. The Ubuntu jobs in `ci.yml` that run the conformance suite and the CLI scenarios build the `marfa` binary and run no Rust tests.

## Bindings

Swift: `bindings/swift/build.sh` builds the XCFramework and its glue for macOS, iOS and the simulator. `withmarfa/marfa-swift` runs it at the commit it pins.

`cargo-swift` embeds one UniFFI bindgen, and the crate's `uniffi` has to write the metadata that bindgen reads. `build.sh` pins `cargo-swift`; `Cargo.toml` and `.github/dependabot.yml` keep `uniffi` to the version that `cargo-swift` embeds. To move to a newer `uniffi`, wait for a `cargo-swift` release that embeds the matching bindgen, then change the `cargo-swift` pin, `uniffi` and the Dependabot ignore in one pull request.

Node: it sits outside the pnpm workspace, so every pnpm call carries `--ignore-workspace`:

```sh
cd bindings/node
pnpm install --ignore-workspace
pnpm --ignore-workspace run build
pnpm --ignore-workspace run check
pnpm --ignore-workspace run test
```

Every surface names a core error by `CoreError::code`: the `code` in the binary's `--json` envelope, and `code` on an error the Node module throws or rejects with. The Node error is an `Error` whose message starts `code: `, with the properties the Swift error carries as fields: `serverCode`, `status`, `retryAfterSeconds`, `origin`, `location`, `path`, `reason`, `unsent`, `expected`, `got`, `served`, `writeSent` and `hash`, each where the error has it. `onEnd` of a `follow` receives that same error, or one coded `listener_threw` where an `onChange` threw. The Swift error answers `code()` with the same word, held by a test that crosses every `CoreError`.

`scripts/binding-proof.sh` drives the built Node binding through an offline write and its verdict against a real server.
