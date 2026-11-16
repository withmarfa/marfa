---
name: land-a-pull-request
description: Merge your own Marfa pull request, from draft to merged. Covers the required checks, the review its risk needs, the five admin merges that go ahead without waiting for Full CI (including a fix to a red main), and the worktree clean-up afterward. Use when a pull request in this repository is finished and needs to reach main, or when main is red.
---

# Land a pull request

A session merges its own pull request. Nobody else will, and nothing reaches `main` any other way.

Getting finished work to `main` comes first. Run the least CI a change needs and do not wait on CI for its own sake. A red `main` is not a release: whoever sees it fixes it forward.

## Before you mark it ready

1. **Check the body.** It carries the sections **Summary**, **Changes**, **Testing**, **Notes for reviewers** and **Checklist**. Summary, Changes and Testing are filled in, and every box in the checklist is ticked. The required check `Pull request description` fails until that is true, and editing the body reruns only that check.
2. **Run the quick check locally:** `pnpm test:changed`, with `pnpm typecheck`, `pnpm lint` and `pnpm format:check`. For a change under `core/`, also the checks in `core/AGENTS.md`.
3. **Get the review its risk calls for,** and state that depth in Notes for reviewers.

Keep a pull request in draft until it is whole. Pieces of work that belong together can share one pull request, or be stacked and merged into one another before the last one lands.

## Merge

1. Mark it ready: `gh pr ready <number>`. This starts the full run, and the gate now reports as `Full CI`.
2. `CodeQL` is not a required check, so a merge does not wait for it. If the change is code, wait for `CodeQL` to finish green before the next step, except in the admin merges below. A change to documentation alone starts no CodeQL run.
3. Set it to merge when the required checks pass: `gh pr merge <number> --squash --auto --delete-branch`. The required checks are `Full CI` and `Pull request description`.
4. Watch the run with `gh pr checks <number> --watch`. If a job failed for a reason outside the change, such as a registry or a package mirror being down, rerun the failed jobs with `gh run rerun <run> --failed`. If a test failed and then passed on a rerun, that is a flaky test: say which test on the pull request, and open an issue for it if none exists.
5. Merge a stack in order, and retarget each pull request to `main` before the branch it sits on is deleted.

A branch does not need to be up to date with `main` to merge. Update it only for a conflict or for something on `main` it needs, never only to be current.

## Merging without waiting for Full CI

In the five cases below, merge with `gh pr merge <number> --squash --admin --delete-branch` and say on the pull request which case applies and why.

- **GitHub merges no draft.** Mark a draft ready, cancel the full run that starts (`gh run cancel <run>`), then merge.
- **CodeQL.** These merges wait for `CodeQL` only when the change is code other than tests and its head has not already passed `CodeQL`. A change that only changes tests, and a clean update of a head that already passed `CodeQL`, do not wait for it.
- **Afterward,** watch the runs of the merged commit on `main` in the background (`gh run list --branch main --commit <sha>`, then `gh run watch <run> --exit-status` for each), and fix `main` forward if one fails.

### Jobs the change cannot affect

`scripts/ci-required.ts` decides which jobs a change runs. When it runs jobs that the change cannot affect, such as the contract's fixtures for a development script:

1. Check that the quick checks pass locally and that `Pull request description` is green.
2. Cancel the run: `gh run cancel <run>`.
3. Merge with the admin merge above.
4. Correct the rule in `scripts/ci-required.ts`, in a pull request of its own, so that the next change of that kind runs only what it needs.

### Check bookkeeping on a head that passed its full checks

Only bookkeeping blocks the merge: a required check left "expected" because a later run on the same commit was cancelled, or auto-merge that does not fire with every required check green. Merge; do not run the checks again.

### A fix for a red main

When the run on `main` fails, for example because two pull requests that each passed clash, or because a test is flaky, fix it before other work, in one small pull request. A red `main` fails the checks of every open pull request. A fix that changes only tests merges once its local quick checks pass. A change to a workflow is not test-only, because a workflow can reach secrets. Any other fix follows the usual rules.

`scripts/ci-required.ts` routes a test inside a Rust source file as source, so such a fix starts the full jobs; cancel them, since the fix still changes only tests.

### A pull request that failed only because main was red

Once `main` is fixed, a pull request merges when the only failed jobs are the ones `main` broke and its local quick checks pass. Compare its failed jobs and tests with the failed run on `main`. Do not rebase it and run everything again.

### A clean update from main of a head that passed Full CI

The only change since that run is a merge or rebase from `main` with no conflict. Cancel the run the update starts, and show that nothing else changed: `git diff origin/main...HEAD` lists the same files and content as before the update, or the update was GitHub's **Update branch** with no conflict.

### What always waits

**A change to data, access, the contract, a migration or the release waits for `Full CI` to pass,** after an update from `main` too. A fix that changes only tests changes none of these. The push to `main` still runs everything, and a release needs a green `main`, so what a skipped run would have caught is caught there.

## Afterward

1. Confirm the pull request reads `MERGED`: `gh pr view <number> --json state`.
2. Remove the worktree and its local branch: `git worktree remove .claude/worktrees/<name>`, then `git branch -D <branch>`, because git sees a squash-merged branch as unmerged. If git refuses the removal, report it rather than forcing it.
3. Bring `main` up to date: `git pull --ff-only`.
4. Cancel any run the merge made pointless. Never hold back a push or a check to save runner time.
