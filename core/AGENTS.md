# The Rust core

These rules add to the root `AGENTS.md` for work under `core/`. Under `core/marfa-server/`, also read `core/marfa-server/AGENTS.md`.

## Crate boundaries

- `marfa-rules` holds the rules a client and the server share. Keep SQLite, HTTP, an async runtime and client code out of it.
- `marfa-server` depends on `marfa-rules`, never on `marfa-core`.
- `marfa-rules/src/contract.rs` is written from `openapi.json` by `pnpm generate`.
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

- The lints are in `Cargo.toml`'s `[workspace.lints]`, which every crate inherits, and in `clippy.toml`. Three apply to one crate and are set in its root, because a crate that inherits cannot add lints: `forbid(unsafe_code)` in `marfa-rules`, and `unwrap_used`, `expect_used` and `disallowed_methods` in `marfa-server`, outside its tests. In the server, read the time through `app/clock.rs`; a place that needs the host's time carries `#[allow(clippy::disallowed_methods, reason = "...")]`. A panic that is right, such as a constant that cannot fail, carries `#[allow(clippy::expect_used, reason = "...")]`. Each `unsafe` block has a `// SAFETY:` comment.
- `cargo deny check` in `core/` holds the dependencies to `deny.toml`: advisories, yanked crates, licenses and duplicate major versions. Run it again for `bindings/swift`, which has its own lockfile: `cargo deny --manifest-path bindings/swift/Cargo.toml --config deny.toml check`. A duplicate warns; add it to `skip-tree` only with the dependency that holds it back.
- `[profile.release]` states `panic = "unwind"`, which the command line, the device core and `marfa-enrichment` rely on. Never set `panic = "abort"`. It also states `strip = "debuginfo"` and `debug = false`: a release program keeps its symbols, so a crash report names the function, and carries no debug information, which would add no line on macOS without a `.dSYM` and made the Linux server about three times larger to download. Never set `strip = "symbols"` or `CARGO_PROFILE_RELEASE_STRIP=symbols`: a stripped program leaves a report that names nothing.
- `rust-toolchain.toml` pins the compiler, and rustup installs it with `rustup toolchain install` from `core/`. It equals the manifest's `toolchain rust` line, which the release builds with.
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

## Tests remove what they make

- A test that locks a folder (a mode with no write or no read, an ACL entry) holds it with a guard that unlocks it when dropped, declared after the `TempDir`: `crate::test_folders::locked` in `marfa-core`, `marfa_acl::testing::locked` or `unlocked_after` elsewhere. A test that fails while a folder is locked would otherwise leave a `.tmp*` folder behind.
- A folder that lasts the whole test process comes from `crate::test_folders::process_folder`, which removes it when the process exits, not from `TempDir::keep`.

## What telemetry may record

- The core records only an operation's name, a count, an outcome word, a write's kind, an HTTP status and an error code. Never an item's content, title, tag, id or key, a credential, an address, a header, a path, a query or an error message. `marfa-core/src/telemetry_tests.rs` fails if a recognizable secret reaches a span or an event.
- Record only through `marfa-core/src/telemetry.rs`, the one source file outside the tests that names `tracing`.
- The binary exports only the field names listed in `marfa-cli/src/telemetry/layer.rs`. To export a new field, add it there.
- Nothing is sent until the owner sets where: the rule and its checks are in the root `AGENTS.md`, "What Marfa promises its owner".
- `core/TELEMETRY.md` describes what is sent. `marfa-cli/src/reference.rs` fails when a telemetry variable the binary reads is missing from it or from `marfa-cli/COMMANDS.md`.

## The command line

- `marfa-cli/COMMANDS.md` is generated from the clap command tree; never edit it. After changing a command or its help text, regenerate it with `MARFA_WRITE_COMMANDS=1 cargo test -p marfa-cli --bin marfa reference` and commit it.
- The docs site renders `COMMANDS.md` as MDX, and a test fails on a `<`, `>`, `{` or `}` outside code. Put a placeholder in help text in backticks.
- The binary writes each path, query name, body key and enum value by hand. `marfa-cli/src/commands/driven.rs` holds every request a command sends to `openapi.json`, so a rename in the document fails it until the command changes too.
- `marfa-cli/README.md` describes how the binary behaves beyond its help text and the contract.

## The shipped catalog

- `marfa-rules/src/builtin_catalog.json` and `packages/types/shipped-shapes.sha256` are written by the rules crate from the definitions in `packages/types/core`; never edit them. After changing a definition, or a rule that judges one, regenerate both with `MARFA_WRITE_CATALOG=1 cargo nextest run -p marfa-rules builtin::catalog_file` and commit. Without the variable the same tests fail when a file differs.
- The lists the catalog carries (field types, reserved names and the rest) are constants in `marfa-rules/src/builtin.rs`, which the rules read and the catalog is written from.
- `packages/types/generated/icon-set-*.json` are written by `scripts/icon-sets.sh` from the Iconify releases pinned, with their integrity hashes, in `scripts/icon-sets.txt`. The script checks each download against its hash and runs `marfa-rules/examples/icon_set.rs`.

## Bindings

- The Node binding sits outside the pnpm workspace. Run pnpm in `bindings/node` with `--ignore-workspace`: `pnpm install --ignore-workspace`, then `pnpm --ignore-workspace run build`, `check` or `test`. The device fixtures need the debug build, `run build:debug`.
- Build the Node module from its own folder, as `pnpm run build` does. A workspace build turns on the `telemetry` feature of `marfa-core` for every crate in it, and the Node and Swift bindings ship with it off.
- `cargo-swift` embeds one UniFFI bindgen, and the crate's `uniffi` must match it. `bindings/swift/build.sh` pins `cargo-swift`, and `bindings/swift/Cargo.toml` and `.github/dependabot.yml` hold `uniffi`. Move all three in one pull request, once a `cargo-swift` release embeds the newer bindgen.
- `core/BINDINGS.md` is the reference for app developers.

## The oldest server

- `marfa-rules/src/release.rs` names the oldest server release the device core works with. A change that makes the core depend on a server change raises it in the same pull request, with the statements in `conformance/spec/device.md` under "The oldest server a device works with".

## Elsewhere

- To boot a throwaway server, claim it and make a key, use the `local-server` skill.
- Before changing the SQLite directory VFS that folder storage uses, read `marfa-core/sqlite/README.md`.
- Before changing the folder watch's record or its health reports, read `marfa-cli/FOLDER-WATCH-RECORD.md` and `marfa-cli/FOLDER-HEALTH.md`: programs on the machine read both as written.
