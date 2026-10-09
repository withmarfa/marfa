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

- **Requests:** every command sends through `marfa_core::http::Http`, the stack the working copy uses: it follows no redirect, reads the contract header on every answer, and renews a refused credential once. A command waits up to 90 seconds for an answer to begin and as long again to read it, which an operation that works before it answers needs; an upload waits on the server's work, and a streamed answer fails after 45 seconds of silence. The binary writes each path, query name, body key and enum value by hand. `commands/driven.rs` runs each command in this process against a local server that refuses every request but the root, and holds each request a command sends, up to that refusal, to `openapi.json`: the method and path, each query name, each key of a JSON body, and each enum value a flag names. A flag that takes any text leaves its value to the server. A rename in the document fails that test.
- **Docs:** `marfa docs` reads the public docs site, which is not a Marfa server, so it is the one command that does not send through `Http`. It has a small client of its own in `commands/docs.rs` that sends no credential, checks no contract, follows up to five redirects, and waits 10 seconds to connect and 30 seconds each for an answer to begin and to be read. It refuses `--url` and `--key`. It reads `https://docs.marfa.so`, or the address in `MARFA_DOCS_URL`.
- **Server:** `--url`, then `MARFA_API_URL`, then the server a kept credential made current.
- **Credential:** `--key`, then `MARFA_API_KEY`, then the operating system's keychain, where `marfa keys keep` and `marfa login` put one. Never a plain file. With both variables set, a command reads and writes no keychain, which is how an agent runs it. Prefer the variable, the keychain, or standard input (`marfa keys keep` reads the key from it) to `--key`: a process argument is readable by other users of the machine and stays in shell history.
- **Plain `http`:** before a command sends a credential, a device code or a refresh token to an `http` address whose host is not `localhost`, in `127.0.0.0/8` or `::1`, it prints one warning to standard error naming the address, and goes on. `--allow-http`, or `MARFA_ALLOW_HTTP` set to `1`, `true`, `yes` or `on`, states that it is intended, for a private network that is already encrypted, and silences it. Each address is warned of once per run. A refusal in `--json` follows the warning line on standard error.
- **Unattended runs:** `MARFA_KEYCHAIN` names a keychain file to use instead of the person's, on macOS, and refuses every prompt. Tests and CI use it; CI fails a run that changed the login keychain's `marfa` entries.

Refresh, `login`, `logout`, `keys keep` and `keys forget` coordinate through one private lock per stored server for each credential store, independent of `HOME`, `TMPDIR` and `XDG_RUNTIME_DIR`. The lock files contain no credentials. For the person's own keychain, they stay under `.marfa-credential-locks` in the home directory recorded by the operating system. For a keychain file that `MARFA_KEYCHAIN` names, they stay in a folder beside the file, named for it with `.locks` added, so a run that removes its keychain's folder leaves no locks behind; a keychain file in `~/Library/Keychains` uses the home directory's locks, because the person's own keychain is one of them. Leave lock files in place while commands may be running. An unsafe lock path is refused before reading or changing stored credentials. `keys forget` works offline without refreshing a token. Logout removes the local sign-in and reports whether server revocation succeeded; without a saved revocation endpoint, it reports `revoked: false`.

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

A copy saves before it has reached a server. `device types declare` takes the types an app saves, as one JSON object or an array, and `device types declared` lists them; until it hydrates the copy checks each write against them and the types Marfa ships, and a hydration registers the ones the instance lacks where the key may, and says which it could not. A drain needs a completed hydration: until the first one completes, it is refused `no_cursor` and sends nothing. `device types served` and `device edge-types served` read the server's catalog without hydrating, so a slice can be chosen first. `hydrate`, `catch-up`, `drain` and the two `served` reads stop on Ctrl-C and exit 3 with the code `canceled`, leaving the store consistent: a stopped hydration refuses reads, a stopped catch-up keeps its cursor, and a stopped drain leaves unsent writes queued. Each binding takes a `Stop`; the caller raises it when its language's cancellation is requested.

Reading commands on an absent store, including `--reader` and `device changes`, report `no_store` and exit 2. Queue JSON retains dependency history; plain “waiting on” names only unresolved dependencies.

## Claim and recover locally

Run the command as the server's operating-system account, using the absolute path in `MARFA_CONTROL_SOCKET`:

```sh
marfa --socket /run/marfa/control.sock setup open
marfa --socket /run/marfa/control.sock setup claim --email owner@example.com
marfa --socket /run/marfa/control.sock owner recover
```

`setup open` issues a five-minute, single-use handoff and opens the browser. Use `--no-browser` to print the link. `setup claim` and `owner recover` ask for a hidden password. For automation, add `--stdin` and send a JSON object containing `email` and `password` for claim, or `password` for recovery. For a remote terminal claim, use `--url https://marfa.example setup claim`; its JSON input also needs `code`. Secrets are never command-line options. Recovery ends browser sessions and keeps ordinary keys, apps and passkeys.

`--socket` cannot be combined with `--url`, `--key`, `MARFA_API_URL` or `MARFA_API_KEY`. It uses no keychain and never falls back to HTTP. A command that streams its answer, such as `blobs download`, reaches the server through the socket too. Local authority carries no key, so a command whose operation needs one, such as `export`, `events` or `items list`, gets `401` from the server, and the command says it needs a key, which `--socket` does not carry. Linux requires `getfacl` from the `acl` package. The socket directory must be owned by the server account with mode `0700`, without access ACLs or symbolic links. The socket is `0600`. A live collision is refused. After a crash, first stop the old process, then remove its stale socket before starting again. Distinct processes need distinct socket paths.

Set `MARFA_CONTROL_ONLY=true` to run only the private listener when public HTTP cannot start. In the service container, `marfa-entrypoint control-only` starts that mode against the configured database; stop an existing listener or choose a distinct private socket path first.

## Build and check

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --no-deps -- -D warnings
cargo nextest run --locked --workspace
cargo build -p marfa-cli   # the device fixtures refuse a binary older than its source
```

Then the same three in `bindings/swift`. Every test binary runs under `scripts/test-limits.sh`, which caps the file size and processor time it can take.

`marfa-cli/COMMANDS.md` is the reference for every command, written from the clap command tree. A test fails when it differs from the binary's help; after changing a command or its help text, regenerate it with `MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference` and commit it.

`scripts/server-up.sh` claims a fresh instance through its private socket and mints an ordinary working key with explicit permissions. It exports `MARFA_TEST_KEY`, `MARFA_TEST_SOCKET`, and the throwaway owner credentials from `scripts/test-owner.example.env` as `MARFA_TEST_OWNER_EMAIL` and `MARFA_TEST_OWNER_PASSWORD`. With `MARFA_SERVER_KEEP`, the key and owner survive restart. Incomplete kept credentials are refused. `scripts/server-keys.test.sh` exercises both boots and the owner's sign-in. Linux requires the `acl` package so the server can check socket ACLs.

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
