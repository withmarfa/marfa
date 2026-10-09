# Marfa

The server (`packages/`), the Rust core every native client embeds (`core/`), and the contract both are held to (`conformance/`). The Swift package lives in `withmarfa/marfa-swift`.

## Working here

- American English in code, comments and commits. Scoped Conventional Commits (`fix(server):`, `refactor(core):`).
- One clone per machine. Parallel work happens in worktrees inside it, made with `git worktree add .claude/worktrees/<name> -b <branch> origin/main`; never a second clone or a sibling folder. Once a branch is merged, `git worktree remove` its worktree and run `git worktree prune`; if git refuses, report it rather than forcing it. Once the work is merged, bring the local `main` up to date (`git pull --ff-only` on `main`) so the next piece of work starts from it.
- Feature branches and pull requests; never push `main`. A session merges its own pull request once every required check is green and the review its risk calls for is done, with that depth stated on the pull request: squash, branch deleted, in stack order. Cancel superseded runs; never hold back a push or a check to ration runners.
- All CI runs on standard GitHub-hosted runners, never personal or paid third-party ones (`ci/workflow-runner.test.ts` enforces it).
- A draft pull request runs only the quick jobs (named in `scripts/ci-required.ts`: the format check, build, typecheck and lint, the type registry and the version check), and the rest is skipped and passes. The gate job of `ci.yml`, `Full CI`, waits for every other job but the nightly report and fails if any failed or was cancelled; on a draft it is named `Draft CI`, so the required `Full CI` stays expected, and blocks a merge, until the run that marking it ready starts has finished. Marking it ready for review, and every push after, runs everything. `Full CI` and `Pull request description` are the required checks, since a merge waits only on required checks; a job added to `ci.yml` is a need of the gate (`ci/full-ci-gate.test.ts` pins it).
- `scripts/ci-required.ts` decides what a pull request and a push to `main` run: each changed path names the jobs that read it, and an unnamed path runs everything. Markdown and the agent folders (`.agents/`, `.claude/`, `.codex/`, `.githooks/`) reach only the format check and the contract's reference check, but for JavaScript and TypeScript there, which lint reads, and except `conformance/spec/`, package READMEs, the command reference, fixtures and generated trees, and `core.yml`'s macOS job leaves a server-only change to the push to `main`. The nightly and a dispatch run all of `ci.yml`, and so does a push to `main` unless it reaches only those checks and `ci.yml` passed on the commit before it, so a green run on `main`, which `release.yml` requires, always vouches for code that passed. A skipped job counts as passed by `Full CI`. When a job starts reading a file, change its rule there; `ci/ci-required.test.ts` pins the rules. The contract's server suites run as shards on runners of their own, and `scripts/ci-required.ts` names the groups a path reaches and writes the matrix: `Conformance` collects them into one verdict for `Full CI`. A change to one group's fixture folder runs that group; a change to what the groups share runs them all, and so does the push to `main`.
- A failed scheduled run of `ci.yml`, `core.yml` or `benchmarks.yml` opens one issue titled `Nightly failed: <workflow>`, or comments on it while it is open, from the `report-failure` job that ends each of those workflows and runs `scripts/report-nightly-failure.sh`. Only a schedule reports, so no pull request run can open an issue; a scheduled workflow added later gets the same job (`ci/nightly-report.test.ts` pins both).
- `codeql.yml` analyzes the whole tree once a week, and a push to `main` or a pull request that is not a draft unless it changes only Markdown, the license, `.claude/`, `.codex/` or issue templates. It is not a required check, so a `paths-ignore` filter starts no run at all for documentation; `ci/ci-required.test.ts` pins it.
- SQLite is the only database. Removed means gone: no shims, aliases, migration paths or compatibility flags.
- No personal details of any machine or person: no absolute paths, hostnames, account names, credentials, or a real machine or person as an example value. No time estimates.
- No test touches the login keychain or raises a dialog.

## Evidence

- The server's behavior is the specification, written down and held in `conformance/`. The docs site is not a source of truth.
- A test that asserts absence needs a witness: show the thing was producible before asserting it is not produced.
- A count, a list or a claim that nothing calls something is checked by running the query, never by trusting a comment.

## Writing

- Public prose (README, docs, issues, pull requests) follows the Google developer documentation style guide, in American English, with docs organized by Diátaxis: tutorials, how-to guides, reference and explanation kept apart.
- Every summary, description and example in `openapi.json` follows `packages/server/API-STYLE.md`.
- Code comments follow the language's own conventions. A comment stays only if it says what the code cannot: a constraint from outside, a non-obvious reason, a trap. Never what the code does, history, removed code, a ticket or a person. When in doubt, it goes.
- The contract in `conformance/spec/` follows the standard in `conformance/spec/README.md`: one requirement per statement, in RFC 2119 keywords and the EARS pattern, each with a permanent ID that every reference uses.

## Versions

A version exists only as a git tag, created only when a release is called for, each the previous plus 0.0.1. Every manifest carries `0.0.0` (`ci/version-fields.test.ts`), and `release.yml` stamps the tag in its own checkout.

## Commands

`pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. The server runs locally with `MARFA_AUTH_SECRET` set and `pnpm --filter @withmarfa/server dev` (port 8600 unless `PORT` says otherwise); every setting is defined once, in the settings schema in `packages/server/src/config.ts`, and read nowhere else. The core's commands are in `core/README.md`.

`core/scripts/server-up.sh` boots a throwaway server for the core's live tests and for trying the sign-in pages by hand. A boot, always on `127.0.0.1`, also creates an owner, whose throwaway email and password are in `core/scripts/test-owner.example.env` and are printed with the URL and keys as `MARFA_TEST_OWNER_EMAIL` and `MARFA_TEST_OWNER_PASSWORD`.

## Secrets

Software-consumed values live in Infisical, never in a file here. A local `.infisical.json`, which Git ignores, maps a checkout to its project; run anything that needs them under `aic-infisical-run -- <command>`. `.env.example` carries names, never values.

## Words

`GLOSSARY.md` fixes the vocabulary, the twelve permission names, the time rule and the error meanings. A pull request is checked against it.

## The contract

`conformance/spec/` states the contract and the fixtures under `conformance/src/suites/` assert it; nothing under `suites/` imports a workspace package. A change to the contract and the change that satisfies it go in the same pull request. `conformance/README.md` says how to run each half: the server's against a server the suite boots itself, the device's against the `marfa` binary and a server the fixture scripts.

## Notes and logs

Session notes and logs are written outside this repository, where the session prompt says. `_trash/` and `_archive/` at the root are never committed.

## Code Review Rules

Report only a real problem: one that breaks the issue's acceptance criteria, a rule written in this file (quote it) or correctness, and say how it fails: the input, state or step, and what goes wrong. If you cannot say how it fails, it is not a finding. Leave formatting, lint and anything CI catches to CI, and skip any convention that is not written down. Check the whole tree, not only the diff, and name each finding by the check it breaks.

- **Done.** The acceptance criteria are met, the change was run for real in the conditions it will meet and not only compiled, new behavior has a test that was seen failing first, and what the pull request claims is true. A test that asserts absence has a witness: the same path with the condition removed produces the thing.
- **True.** A comment, doc, instruction file or contract statement the change touches or leaves untrue is a finding, fixed in the same change. New prose follows the standard under Writing for its kind. A claim of completeness ("all callers updated") is checked by searching, not accepted.
- **Nothing left behind.** Dead code, shims, old names and references to removed things.
- **Every path.** A permission, check or interpretation of a value holds at every door, including one the change adds, and in every copy of the logic: the server and the working copy, a fallback, a retry. Nothing is exempted by a name or field someone else controls.
- **Check and write are one step.** A decision is made on the state the write commits, with no wait, retry or asynchronous boundary between. Intent kept for a retry is captured, unchangeable, when it is sent, and announcements follow the order the writes were admitted.
- **Report only what is known.** Success, absence, completeness and current authority are claimed only on evidence that proves them: a refusal does not prove a write never committed, an old receipt does not prove present access, a partial snapshot is not a full inventory. A failure is not cleared by an unrelated operation.
- **Keep what people made.** A refused, failed or uncertain write is kept where the person can get it back, never dropped or rolled over newer work. Clean-up acts only on what it proved gone, and an edit keeps every byte it did not mean to change.
- **Real conditions.** Real clocks and dates, number ranges across languages and SQLite, runtime limits, slow or absent peers, untidy input, other platforms and file systems. One bad item, slow peer or hiccup stays contained and never takes down the batch, the folder or the job.
- **Flaky tests.** An unexplained flaky test is a finding: reproduce it, or say exactly why it cannot recur.

Mark a finding blocking when it changes how Marfa behaves or breaks a criterion or rule, and a quick fix when it is a name, a stale reference or a wrong count. Keep a problem that was there before the change apart from findings against it, and list it only if it is clearly wrong and would keep coming up.
