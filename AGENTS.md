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

`pnpm install`, `pnpm build`, `pnpm test` (SQLite), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. The server runs locally with `PORT` and `MARFA_AUTH_SECRET` set and `pnpm --filter @withmarfa/server dev`; `.env.example` is a starter rather than the full list, most of which `config.ts` reads.

## Words

`GLOSSARY.md` at the root fixes the vocabulary: the words this repository uses, the words it does not, the seven permission names, the time rule and the error meanings. A pull request is checked against it.

## Conformance

`conformance/` holds the contract: black-box fixtures and the written specification under `conformance/spec/` that states what they assert. Nothing under `conformance/src/suites/` may import a workspace package.

The server's half is driven over HTTP against a server the suite booted itself on SQLite, never a remote one. `pnpm marfa:up` boots the server in this checkout and writes the `MARFA_API_URL`, `MARFA_API_KEY` and `MARFA_OPERATOR_KEY` the run sources.

The device's half, `conformance/src/suites/device/`, gates the `marfa` binary against a server the fixture scripts, because the verdicts a device reaches include failures the real server cannot be asked for. `MARFA_DEVICE_BIN` names the binary and `device/fidelity.test.ts` holds the scripting to what the real server does. `conformance/README.md` has the rest.

A change to the contract and the change to the server that satisfies it belong in the same pull request. The `conformance` job in `ci.yml` is the gate, and it is not lint-clean by the root ESLint config on purpose — `eslint.config.js` says why.

## Notes and logs

Session notes, running logs and open questions are written outside this repository, where the session prompt says.
