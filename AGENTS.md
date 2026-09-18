# Marfa

Under rebuild since 17 September 2026. The decisions in force live outside this repository, in the maintainer's working folder, and every session is pointed at them by its prompt. Nothing here restates or overrides them.

## In force

- American English in code, comments and commits. Scoped Conventional Commits (`refactor(server):`, `feat(core):`). Feature branches and pull requests. Never push `main`. Nothing is merged without the maintainer.
- Every Actions workflow runs on the self-hosted runner pool, never on GitHub-hosted runners.
- SQLite is the only database. Removed means gone: no shims, no aliases, no migration paths, no compatibility flags.
- The server's behavior is the specification. The docs site is not a source of truth, and no docs connector is used in a session even if one is offered.
- No personal details of any machine or person in this repository: no absolute paths, hostnames, account names or credentials.
- No time estimates anywhere.

## Commands

`pnpm install`, `pnpm build`, `pnpm test` (SQLite), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. The server runs locally with `DB_DIALECT=sqlite`, `PORT` and `MARFA_AUTH_SECRET` set and `pnpm --filter @withmarfa/server dev`; `.env.example` lists every variable. An ignored `_archive/agents/` folder may hold the previous instruction files as a record of what existed; nothing in them is in force.

## Notes and logs

Session notes, running logs and open questions are written outside this repository, where the session prompt says.
