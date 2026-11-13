# Marfa

Marfa's server, the Rust core every native client embeds and the `marfa` command line, all under `core/`, and the contract they are held to, under `conformance/`. `packages/` holds the TypeScript client and the shipped type definitions. The Swift SDK lives in `withmarfa/marfa-swift`.

## Where an area's rules are

Read the file for an area before you work there. Your tool may not load it for you.

- **`core/`:** `core/AGENTS.md`. Under `core/marfa-server/`, also `core/marfa-server/AGENTS.md`.
- **`conformance/`:** `conformance/AGENTS.md`. Before you write a contract statement, `conformance/spec/README.md`.
- **`.github/`, `ci/` or `scripts/ci-required.ts`:** `.github/AGENTS.md`.
- **Text in `openapi.json`:** `API-STYLE.md`.
- **A shipped type:** `packages/types/README.md`.
- **Procedures are skills** in `.agents/skills/`: `release`, `land-a-pull-request`, `local-server`, `run-the-contract`, `move-pdfium`.

## Working here

- American English in code, comments, commits and prose.
- Scoped Conventional Commits, such as `fix(server):` or `refactor(core):`. The types in use are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `build` and `chore`.
- Make worktrees in `.claude/worktrees/` (`git worktree add .claude/worktrees/<name> -b <branch> origin/main`). Once the work is merged, remove the worktree and its local branch (`git worktree remove`, then `git branch -D`, because git sees a squash-merged branch as unmerged) and run `git pull --ff-only` on `main`. If git refuses a removal, report it rather than forcing it.
- Work reaches `main` only through a pull request from a feature branch. Never push `main`.
- Open a pull request as a draft. Its body carries the sections **Summary**, **Changes**, **Testing**, **Notes for reviewers** and **Checklist**, with the checklist ticked honestly. The required check `Pull request description` fails until they are there, Summary, Changes and Testing are filled in, and every box is ticked.
- A draft runs only the quick jobs. Marking a pull request ready for review, and every push after, runs everything the change can affect. The required checks are `Full CI` and `Pull request description`.
- A session merges its own pull request once the required checks are green and the review its risk calls for is done, with that depth stated on the pull request: squash, branch deleted, in stack order. The `land-a-pull-request` skill has the steps, and says when a merge may go ahead past jobs the change cannot affect. That is never allowed for a change to data, access, the contract, a migration or the release.
- `scripts/ci-required.ts` decides which jobs a change runs, and a job it skips counts as passed. When a job starts reading a file, change that file's rule in the same pull request.
- SQLite is the only database.
- Removed means gone: no shims, aliases or compatibility flags.
- No personal details of any machine or person: no absolute paths, host names, account names, credentials, or a real machine or person as an example value. No time estimates.
- A test sends no telemetry, touches no login keychain and raises no dialog.

## Evidence

- The committed `openapi.json` and the contract in `conformance/` are what the server is held to. Where the server and either disagree, whichever is wrong is fixed. The docs site is not a source of truth.
- A test that asserts absence needs a witness: show the thing was producible before asserting it is not produced.
- A count, a list or a claim that nothing calls something is checked by running the query, never by trusting a comment.

## Speed

Guidance, not rules:

- Measure a change that can affect speed or memory at the size people reach, before and after, and put both figures in the pull request.
- A cost should grow with the change, not with the data.
- A background part with nothing to do uses almost no CPU. A loop that wakes itself is a bug.
- No request holds up the others. A long job runs in pages and lets other requests through.

## Writing

- Public prose (a README, an issue, a pull request) follows the Google developer documentation style guide. Docs are organized by Diátaxis: tutorials, how-to guides, reference and explanation kept apart.
- A change that a reader of the docs at docs.marfa.so would notice, or a fault found in them, opens an issue on `withmarfa/docs` saying what changed or is wrong, why and for whom, and which release carries it. Do not edit the docs: they are rewritten from those issues after each release.
- A code comment stays only if it says what the code cannot: a constraint from outside, a reason that is not obvious, a trap. Never what the code does, history, removed code, an issue or a person. When in doubt, it goes.
- An instruction file such as this one holds only what an agent cannot work out from the code. A procedure is a skill, and reference sits beside the code it describes.
- `GLOSSARY.md` fixes the vocabulary and the twelve permission names. A pull request is checked against it.

## Versions

A version exists only as a git tag. Every manifest carries `0.0.0`, and the release stamps the tag in its own checkout (`ci/version-fields.test.ts`). The `release` skill has the steps.

## Commands

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- `pnpm test:changed` is the quick check before a push: the tests your diff against `origin/main` selects, plus the tests that read files by path, which a diff cannot select. `scripts/whole-tree-tests.ts` lists those. A new test whose verdict depends on a file it does not import goes on that list.
- `pnpm test` does not run the contract's offline checks. Run `pnpm test:offline-lane` after a change to a contract chapter, a fixture's title or a statement.
- The core's commands are in `core/AGENTS.md`. Run the `marfa` command line in a test or a script with `MARFA_NO_KEYCHAIN=1`, or with both `MARFA_API_URL` and `MARFA_API_KEY` set.
- The `local-server` skill boots a throwaway server, and the `run-the-contract` skill runs the contract's fixtures against one.

## Secrets

Values that software reads live in Infisical, never in a file here. A local `.infisical.json`, which Git ignores, maps a checkout to its project. Run anything that needs them with `infisical run -- <command>`. `.env.example` carries names, never values.

## The contract

`conformance/spec/` states the contract, and the fixtures under `conformance/src/suites/` assert it. A change to what Marfa does and the change to the contract that states it go in the same pull request.

## Notes and logs

Session notes and logs are written outside this repository, where the session's prompt says. `_trash/` and `_archive/` at the root are never committed.

## Code Review Rules

Report only a real problem: one that breaks the issue's acceptance criteria, a rule written in an instruction file (quote it) or correctness, and say how it fails: the input, state or step, and what goes wrong. If you cannot say how it fails, it is not a finding. Leave formatting, lint and anything CI catches to CI, and skip any convention that is not written down. Check the whole tree, not only the diff, and name each finding by the check it breaks.

The nested files `core/marfa-server/AGENTS.md` and `conformance/AGENTS.md` add review rules for their areas. Read them when a change touches those areas.

- **Done.** The acceptance criteria are met, the change was run for real in the conditions it will meet and not only compiled, new behavior has a test that was seen failing first, and what the pull request claims is true. A test that asserts absence has a witness: the same path with the condition removed produces the thing.
- **True.** A comment, doc, instruction file or contract statement the change touches or leaves untrue is a finding, fixed in the same change. New prose follows the standard under Writing for its kind. A claim of completeness ("all callers updated") is checked by searching, not accepted.
- **Nothing left behind.** Dead code, shims, old names and references to removed things.
- **Every path.** A permission, check or interpretation of a value holds at every operation, including one the change adds, and in every copy of the logic: the server and the working copy, a fallback, a retry. Nothing is exempted by a name or field someone else controls.
- **Check and write are one step.** A decision is made on the state the write commits, with no wait, retry or asynchronous boundary between. Intent kept for a retry is captured, unchangeable, when it is sent, and announcements follow the order the writes were admitted.
- **Report only what is known.** Success, absence, completeness and current authority are claimed only on evidence that proves them: a refusal does not prove a write never committed, an old receipt does not prove present access, a partial snapshot is not a full inventory. A failure is not cleared by an unrelated operation.
- **Keep what people made.** A refused, failed or uncertain write is kept where the person can get it back, never dropped or rolled over newer work. Clean-up acts only on what it proved gone, and an edit keeps every byte it did not mean to change.
- **Real conditions.** Real clocks and dates, number ranges across languages and SQLite, runtime limits, slow or absent peers, untidy input, other platforms and file systems. One bad item, slow peer or hiccup stays contained and never takes down the batch, the folder or the job.
- **Flaky tests.** An unexplained flaky test is a finding: reproduce it, or say exactly why it cannot recur.

Mark a finding blocking when it changes how Marfa behaves or breaks a criterion or rule, and a quick fix when it is a name, a stale reference or a wrong count. Keep a problem that was there before the change apart from findings against it, and list it only if it is clearly wrong and would keep coming up.
