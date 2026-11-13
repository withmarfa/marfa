# The server

These rules add to the root `AGENTS.md` and `core/AGENTS.md` for work under `core/marfa-server/`.

- The server does what the contract in `conformance/spec/` states, and `openapi.json` is its interface. Where the server and either disagree, fix whichever is wrong.
- Put a rule that the core and the command line also apply in `core/marfa-rules/`, which the server shares with them.
- The server has one migration, `core/marfa-server/src/db/migrations/0001_baseline.sql`, which grows until 0.1 ships: put a schema change in it.
- The `test-hooks` feature gives the contract fixtures their hooks. The tests compile the server with it and a release build leaves it out, so also lint without it: `cargo clippy --locked -p marfa-server --no-deps -- -D warnings`. The contract fixtures need a server built with `--features test-hooks`.
- To boot a throwaway server on this machine, use the `local-server` skill.

## Code Review Rules

- **One write path.** Every item, edge and type write goes through its area's one write function inside `App::write`.
- **Access on the committed state.** Every permission is decided in `app/access`, on the state the write commits. An operation that checks a permission only before the write is a finding.
- **SQL stays private.** SQL stays inside its area's module.
- **No panics.** Server code never panics on a request or a stored value: no `unwrap`, `expect` or unchecked index on either.
- **Stored values are read, not assumed.** A stored value that does not read is refused or reported, never quietly defaulted.
- **Blocking work off the runtime.** Password hashing, file reading and SQLite outside the writer thread run off the async runtime.
- **Nothing kept for compatibility.** A setting, column, name or shape kept only for compatibility with something that no longer exists is a finding.
- **No stand-ins.** Code in the server that exists only to make a fixture pass is a finding.
