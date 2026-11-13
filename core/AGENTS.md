# The Rust core

These rules add to the root `AGENTS.md` for work under `core/`. Under `core/marfa-server/`, also read `core/marfa-server/AGENTS.md`.

## Crate boundaries

- `marfa-rules` holds the rules a client and the server share. Keep SQLite, HTTP, an async runtime and client code out of it.
- `marfa-server` depends on `marfa-rules`, never on `marfa-core`.
- `marfa-core/src/contract.rs` is written from `openapi.json` by `pnpm generate`.
- `withmarfa/marfa-swift` builds `bindings/swift` at the commit it pins, so a change there reaches Swift apps only when that pin moves.

## Build and check

- Run cargo from `core/` or a folder below it. Cargo reads `core/.cargo/config.toml` only from the current directory and its parents, so `cargo --manifest-path core/Cargo.toml` from the repository root runs tests without the runner `scripts/test-limits.sh` and its guards.
- Check the workspace as CI does:

  ```sh
  cargo fmt --all --check
  cargo clippy --locked --workspace --all-targets --no-deps -- -D warnings
  cargo nextest run --locked --workspace
  ```

  Then `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo nextest run --locked` in `bindings/swift`.

- Run tests with `cargo nextest run`, not `cargo test`. Tests that set a process-wide fault depend on nextest's one process per test.
- Run `cargo build -p marfa-cli` before the device fixtures: they refuse a `marfa` binary older than its source.
- Test `marfa-enrichment` with `--features fault-injection` too; its `README.md` says how to build and check the native readers.

## Debug-only faults

- The `crate::fault` helpers in `marfa-core/src/fault.rs` exist only with debug assertions. CI also checks every target in release, so gate a test or a line that uses them on `#[cfg(debug_assertions)]`. A missing gate fails only in CI.
- A benchmark that runs in release with fault points needs `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true`.

## Tests send no telemetry and touch no keychain

- Start `marfa` in a CLI integration test only through `marfa-cli/tests/support/quiet.rs`; `marfa-cli/tests/quiet_binary.rs` fails a test file that starts it another way. A process a script starts gets the same guard from `scripts/no-telemetry.sh`.
- A test that wants telemetry sets its own environment.
- An integration test that needs a keychain uses `marfa-cli/tests/isolated/mod.rs`, which gives it a keychain file of its own. CI runs the macOS tests under `scripts/login-keychain-unchanged.sh`, which fails a run that changed the login keychain's `marfa` entries.
- Never run `marfa login` or `marfa keys keep` against the login keychain.

## What telemetry may record

- The core records only an operation's name, a count, an outcome word, a write's kind, an HTTP status and an error code. Never an item's content, title, tag, id or key, a credential, an address, a header, a path, a query or an error message. `marfa-core/src/telemetry_tests.rs` fails if a recognizable secret reaches a span or an event.
- Record only through `marfa-core/src/telemetry.rs`, the one source file outside the tests that names `tracing`.
- The binary exports only the field names listed in `marfa-cli/src/telemetry/layer.rs`. To export a new field, add it there.
- An exception sends the fixed sentence `marfa-cli/src/telemetry/describe.rs` holds for its kind of error, never the error's message.
- `core/TELEMETRY.md` describes what is sent. `marfa-cli/src/reference.rs` fails when a telemetry variable the binary reads is missing from it or from `marfa-cli/COMMANDS.md`.

## The command line

- `marfa-cli/COMMANDS.md` is generated from the clap command tree; never edit it. After changing a command or its help text, regenerate it with `MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference` and commit it.
- The docs site renders `COMMANDS.md` as MDX, and a test fails on a `<`, `>`, `{` or `}` outside code. Put a placeholder in help text in backticks.
- The binary writes each path, query name, body key and enum value by hand. `marfa-cli/src/commands/driven.rs` holds every request a command sends to `openapi.json`, so a rename in the document fails it until the command changes too.
- `marfa-cli/README.md` describes how the binary behaves beyond its help text and the contract.

## Bindings

- The Node binding sits outside the pnpm workspace. Run pnpm in `bindings/node` with `--ignore-workspace`: `pnpm install --ignore-workspace`, then `pnpm --ignore-workspace run build`, `check` or `test`. The device fixtures need the debug build, `run build:debug`.
- Build the Node module from its own folder, as `pnpm run build` does. A workspace build turns on the `telemetry` feature of `marfa-core` for every crate in it, and the Node and Swift bindings ship with it off.
- `cargo-swift` embeds one UniFFI bindgen, and the crate's `uniffi` must match it. `bindings/swift/build.sh` pins `cargo-swift`, and `bindings/swift/Cargo.toml` and `.github/dependabot.yml` hold `uniffi`. Move all three in one pull request, once a `cargo-swift` release embeds the newer bindgen.
- `core/BINDINGS.md` is the reference for app developers.

## Elsewhere

- To boot a throwaway server, claim it and make a key, use the `local-server` skill.
- Before changing the SQLite directory VFS that folder storage uses, read `marfa-core/sqlite/README.md`.
- Before changing the folder watch's record or its health reports, read `marfa-cli/FOLDER-WATCH-RECORD.md` and `marfa-cli/FOLDER-HEALTH.md`: programs on the machine read both as written.
