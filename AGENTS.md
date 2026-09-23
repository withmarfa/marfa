# Marfa

Under rebuild since 17 September 2026. The decisions in force live outside this repository, in the maintainer's working folder, and every session is pointed at them by its prompt. Nothing here restates or overrides them.

## In force

- American English in code, comments and commits. Scoped Conventional Commits (`refactor(server):`, `feat(core):`). Feature branches and pull requests. Never push `main`. A session merges its own pull request once every required check is green and its reviewers have run: squash, branch deleted, in stack order.
- One clone of this repository per machine. Parallel work happens in worktrees made by the agent's own worktree mechanism, never in a second clone or a sibling folder.
- Every Actions workflow runs on the self-hosted runner pool, never on GitHub-hosted runners.
- SQLite is the only database. Removed means gone: no shims, no aliases, no migration paths, no compatibility flags.
- The server's behavior is the specification. The docs site is not a source of truth, and no docs connector is used in a session even if one is offered.
- No personal details of any machine or person in this repository: no absolute paths, hostnames, account names, credentials, or a real machine or person as an example value.
- No time estimates anywhere.

## Versions

- A version exists only as a git tag, and tags are the maintainer's. An agent never creates a tag and never writes a version into a file.
- Every version is the previous one plus 0.0.1, whatever the size of the change, with no milestone steps. The first is 0.0.1.
- Every manifest carries the placeholder `0.0.0`, `ci/version-fields.test.ts` refuses a tree where one does not, and `release.yml` stamps the tag's version into its own checkout with `scripts/release/stamp-version.sh`.

## Evidence

- A test that asserts absence needs a witness: show the thing was producible before asserting it is not produced, or the assertion passes against nothing.
- A comment is probed, not read. A count, a list, or a claim that nothing calls something is checked by running the query, never by agreeing with it.
- A comment survives only if it explains a why the code cannot. Anything that narrates history, removed code, a former dialect or mode, a ticket or a person, goes, in every file the work touches.
- Reviewers run as work lands, not at the end. After each step, sub-agent reviewers ask whether anything legacy is left and whether what was done is done; findings are fixed before the step is called done. Run an adversarial reviewer after the read-only one, not beside it, because its mutations trip the other's tree checks.

## Commands

`pnpm install`, `pnpm build`, `pnpm test` (SQLite), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. The server runs locally with `PORT` and `MARFA_AUTH_SECRET` set and `pnpm --filter @withmarfa/server dev`; `.env.example` is a starter rather than the full list, most of which `config.ts` reads.

## Secrets

Software-consumed values live in Infisical, never in a file here. `.infisical.json` maps this repository to its project, environment and folder; anything that needs those values runs under `aic-infisical-run -- <command>` from the checkout. `.env.example` carries names, never values.

## Words

`GLOSSARY.md` at the root fixes the vocabulary: the words this repository uses, the words it does not, the seven permission names, the time rule and the error meanings. A pull request is checked against it.

## Conformance

`conformance/` holds the contract: black-box fixtures and the written specification under `conformance/spec/` that states what they assert. Nothing under `conformance/src/suites/` may import a workspace package.

The server's half is driven over HTTP against a server the suite booted itself on SQLite, never a remote one. `pnpm marfa:up` boots the server in this checkout and writes the `MARFA_API_URL`, `MARFA_API_KEY`, `MARFA_OPERATOR_KEY` and `MARFA_BLOB_PATH` the run sources.

The device's half, `conformance/src/suites/device/`, gates the `marfa` binary against a server the fixture scripts, because the verdicts a device reaches include failures the real server cannot be asked for. `MARFA_DEVICE_BIN` names the binary and `device/fidelity.test.ts` holds the scripting to what the real server does. `conformance/README.md` has the rest.

A change to the contract and the change to the server that satisfies it belong in the same pull request. The `conformance` job in `ci.yml` is the gate, and it is not lint-clean by the root ESLint config on purpose: `eslint.config.js` says why.

## Notes and logs

Session notes, running logs and open questions are written outside this repository, where the session prompt says. `_trash/` and `_archive/` at the root are never committed: something a session is refused permission to delete is moved there and recorded in its session note.
