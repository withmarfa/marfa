---
name: land-a-pull-request
description: Merge your own Marfa pull request, from draft to merged. Covers the required checks, the review its risk needs, when a merge may go ahead past jobs the change cannot affect, and the worktree clean-up afterward. Use when a pull request in this repository is finished and needs to reach main.
---

# Land a pull request

A session merges its own pull request. Nobody else will, and nothing reaches `main` any other way.

## Before you mark it ready

1. **Check the body.** It carries the sections **Summary**, **Changes**, **Testing**, **Notes for reviewers** and **Checklist**. Summary, Changes and Testing are filled in, and every box in the checklist is ticked. The required check `Pull request description` fails until that is true, and editing the body reruns only that check.
2. **Run the quick check locally:** `pnpm test:changed`, with `pnpm typecheck`, `pnpm lint` and `pnpm format:check`. For a change under `core/`, also the checks in `core/AGENTS.md`.
3. **Get the review its risk calls for,** and state that depth in Notes for reviewers.

## Merge

1. Mark it ready: `gh pr ready <number>`. This starts the full run, and the gate now reports as `Full CI`.
2. `CodeQL` is not a required check, so a merge does not wait for it. If the change is code, wait for `CodeQL` to finish green before the next step. A change to documentation alone starts no CodeQL run.
3. Set it to merge when the required checks pass: `gh pr merge <number> --squash --auto --delete-branch`. The required checks are `Full CI` and `Pull request description`.
4. Watch the run with `gh pr checks <number> --watch`. If a job failed for a reason outside the change, such as a registry or a package mirror being down, rerun the failed jobs with `gh run rerun <run> --failed`. If a test failed and then passed on a rerun, that is a flaky test: say which test on the pull request, and open an issue for it if none exists.
5. Merge a stack in order, and retarget each pull request to `main` before the branch it sits on is deleted.

## When CI runs jobs the change cannot affect

`scripts/ci-required.ts` decides which jobs a change runs. When it runs jobs that the change cannot affect, such as the contract's fixtures for a development script:

1. Check that the quick checks pass locally and that `Pull request description` is green.
2. Cancel the run: `gh run cancel <run>`.
3. Merge with `gh pr merge <number> --squash --admin --delete-branch`.
4. Say on the pull request that you did, and why the jobs could not be affected.
5. Correct the rule in `scripts/ci-required.ts`, in a pull request of its own, so that the next change of that kind runs only what it needs.

**Never do this for a change to data, access, the contract, a migration or the release.** Those wait for `Full CI`. The push to `main` still runs everything.

## Afterward

1. Confirm the pull request reads `MERGED`: `gh pr view <number> --json state`.
2. Remove the worktree and its local branch: `git worktree remove .claude/worktrees/<name>`, then `git branch -D <branch>`, because git sees a squash-merged branch as unmerged. If git refuses the removal, report it rather than forcing it.
3. Bring `main` up to date: `git pull --ff-only`.
4. Cancel any run the merge made pointless. Never hold back a push or a check to save runner time.
