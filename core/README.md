# Marfa core

The Rust engine every native client embeds: a local SQLite working copy of a slice of one Marfa server, kept current from its event log, read locally, and written to through a queue that holds each write until the server answers it. `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md` say what it does; the fixtures under `conformance/src/suites/device/` hold the `marfa` binary to them.

| Crate | What it is |
| --- | --- |
| `marfa-core` | The engine. `src/contract.rs` is written from `openapi.json` by `pnpm generate` |
| `marfa-client` | The Rust client, generated from `openapi.json` by `pnpm generate` (needs Java 11 or later); never edited by hand |
| `marfa-cli` | The `marfa` binary |
| `bindings/swift` | The UniFFI crate and `build.sh`, which packages it for `withmarfa/marfa-swift`; a cargo workspace of its own |
| `bindings/node` | The napi-rs module `@withmarfa/core` |

## The binary

`marfa --help` lists every command, the exit codes and the `--json` error shape; `marfa operations` maps each published operation to its command. `marfa device --db PATH` is a working copy, and `marfa folders` a folder on disk that carries its own store.

- **Server:** `--url`, then `MARFA_API_URL`, then the server a kept credential made current.
- **Credential:** `--key`, then `MARFA_API_KEY`, then the operating system's keychain, where `marfa keys keep` and `marfa login` put one. Never a plain file. With both variables set, a command reads and writes no keychain, which is how an agent runs it.
- **Unattended runs:** `MARFA_KEYCHAIN` names a keychain file to use instead of the person's, on macOS, and refuses every prompt. Tests and CI use it; CI fails a run that changed the login keychain's `marfa` entries.

Refresh, `logout` and `keys forget` coordinate through one private lock per stored server for the operating-system user, independent of `HOME`, `TMPDIR` and `XDG_RUNTIME_DIR`. The lock files contain no credentials and stay under `.marfa-credential-locks` in the home directory recorded by the operating system; leave them in place while commands may be running. An unsafe lock path is refused before reading or changing stored credentials. `keys forget` works offline without refreshing a token. Logout removes the local sign-in and reports whether server revocation succeeded; without a saved revocation endpoint, it reports `revoked: false`.

### Process outcomes

| Exit | Meaning |
| --- | --- |
| 0 | Completed, including a completed drain containing refused writes |
| 1 | Request refused or invalid, including another contract |
| 2 | Invalid command line, missing store, or missing server |
| 3 | Environmental failure, including network failure, rate limits, and full local storage |
| 4 | Working-copy or queue rule, other store fault, or unavailable credential storage |
| 5 | Missing or refused credential, or ended sign-in |

`device drain` preserves its complete stdout report when it exits 3 for an unavailable pass or undelivered writes, or 5 for a credential-stopped pass. It prints no second error envelope for these report outcomes. Credential stop takes precedence if both occur. A completed pass with refused writes exits 0 and its plain output separately counts refused verdicts; JSON retains each typed verdict. Held writes alone do not make an environmental failure. A direct renewal error prints its typed error on stderr with empty stdout; earlier answers remain committed and the current queued request, idempotency key, and refusal count stay unchanged. Local renewal failures carry no invented server status. An environmental renewal failure while sending a queued request returns the unavailable report; a renewal failure during a follow-up read can end the call with its typed error.

A copy saves before it has reached a server. `device types declare` takes the types an app saves, as one JSON object or an array, and `device types declared` lists them; until a first hydration the copy checks each write against them and the types Marfa ships, and the first hydration registers the ones the instance lacks where the key may, and says which it could not. `hydrate`, `catch-up` and `drain` stop on Ctrl-C and exit 3 with the code `cancelled`, leaving the store consistent: a stopped hydration refuses reads, a stopped catch-up keeps its cursor, and a stopped drain leaves unsent writes queued. A binding takes a `Stop` and raises it from the language's own cancellation.

Reading commands on an absent store, including `--reader` and `device changes`, report `no_store` and exit 2. Queue JSON retains dependency history; plain “waiting on” names only unresolved dependencies.

## Build and check

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --exclude marfa-client --all-targets --no-deps -- -D warnings
cargo nextest run --locked --workspace --exclude marfa-client
cargo build -p marfa-cli   # the device fixtures refuse a binary older than its source
```

Then the same three in `bindings/swift`. `Core checks` in `ci.yml` runs them on a pull request that touches the core, and `core.yml` adds the tests that need a live server (`scripts/server-up.sh` boots one; `--run-ignored only` runs them), the Swift crate's release build and the Node binding's proof. Every test binary runs under `scripts/test-limits.sh`, which caps the file size and processor time it can take.

`scripts/server-up.sh` exports `MARFA_TEST_KEY` for ordinary working requests and `MARFA_TEST_OPERATOR_KEY` for operator-only inspection. With `MARFA_SERVER_KEEP`, both keys are kept and returned on restart. A kept directory without its operator key is refused; use a fresh directory. `scripts/server-keys.test.sh` checks both roles against the server on first boot and after restart.

## Bindings

Swift: `bindings/swift/build.sh` builds the XCFramework and its glue for macOS, iOS and the simulator. `withmarfa/marfa-swift` runs it at the commit it pins.

Node: it sits outside the pnpm workspace, so every pnpm call carries `--ignore-workspace`:

```sh
cd bindings/node
pnpm install --ignore-workspace
pnpm --ignore-workspace run build
pnpm --ignore-workspace run check
pnpm --ignore-workspace run test
```

`scripts/binding-proof.sh` drives the built Node binding through an offline write and its verdict against a real server.
