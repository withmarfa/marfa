# Marfa

The server (`packages/`), the Rust core every native client embeds (`core/`), and the contract both are held to (`conformance/`). The Swift package lives in `withmarfa/marfa-swift`.

## Working here

- American English in code, comments and commits. Scoped Conventional Commits (`fix(server):`, `refactor(core):`).
- One clone per machine. Parallel work happens in worktrees inside it, made with `git worktree add .claude/worktrees/<name> -b <branch> origin/main`; never a second clone or a sibling folder. Once a branch is merged, `git worktree remove` its worktree and run `git worktree prune`; if git refuses, report it rather than forcing it.
- Feature branches and pull requests; never push `main`. A session merges its own pull request once every required check is green and the review its risk calls for is done, with that depth stated on the pull request: squash, branch deleted, in stack order. Cancel superseded runs; never hold back a push or a check to ration runners.
- All CI runs on standard GitHub-hosted runners, never personal or paid third-party ones (`ci/workflow-runner.test.ts` enforces it).
- `scripts/ci-required.ts` decides what a pull request runs: each changed path names the jobs that read it, Markdown reaches only the format check except `conformance/spec/` and package READMEs, and an unnamed path, a push to `main`, the nightly or a dispatch runs everything. A skipped job passes its required check. When a job starts reading a file, change its rule there; `ci/ci-required.test.ts` pins the rules.
- SQLite is the only database. Removed means gone: no shims, aliases, migration paths or compatibility flags.
- No personal details of any machine or person: no absolute paths, hostnames, account names, credentials, or a real machine or person as an example value. No time estimates.
- No test touches the login keychain or raises a dialog.

## Evidence

- The server's behavior is the specification, written down and held in `conformance/`. The docs site is not a source of truth.
- A test that asserts absence needs a witness: show the thing was producible before asserting it is not produced.
- A count, a list or a claim that nothing calls something is checked by running the query, never by trusting a comment.
- A comment stays only if it says what the code cannot: a constraint from outside, a non-obvious reason, a trap. Never what the code does, history, removed code, a ticket or a person. When in doubt, it goes.

## Versions

A version exists only as a git tag, created only when a release is called for, each the previous plus 0.0.1. Every manifest carries `0.0.0` (`ci/version-fields.test.ts`), and `release.yml` stamps the tag in its own checkout.

## Commands

`pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. The server runs locally with `MARFA_AUTH_SECRET` set and `pnpm --filter @withmarfa/server dev` (port 8600 unless `PORT` says otherwise); `packages/server/src/config.ts` reads the full list of settings. The core's commands are in `core/README.md`.

## Secrets

Software-consumed values live in Infisical, never in a file here. `.infisical.json` maps this repository to its project; run anything that needs them under `aic-infisical-run -- <command>`. `.env.example` carries names, never values.

## Words

`GLOSSARY.md` fixes the vocabulary, the seven permission names, the time rule and the error meanings. A pull request is checked against it.

## The contract

`conformance/spec/` states the contract and the fixtures under `conformance/src/suites/` assert it; nothing under `suites/` imports a workspace package. A change to the contract and the change that satisfies it go in the same pull request. `conformance/README.md` says how to run each half: the server's against a server the suite boots itself, the device's against the `marfa` binary and a server the fixture scripts.

## Notes and logs

Session notes and logs are written outside this repository, where the session prompt says. `_trash/` and `_archive/` at the root are never committed.
