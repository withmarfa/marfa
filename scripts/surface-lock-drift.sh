#!/usr/bin/env bash
# The surface-lock guard, against the base this change actually merges into.
#
# CI resolves the base as `HEAD^1` of the pull request's merge commit, and
# says at length why: the payload's base and the checkout's can diverge on a
# re-run, and every disagreement lands on the version-moved branch as a silent
# skip. Locally there is no merge commit, so the nearest true answer is the
# merge base with `origin/main` — not `origin/main` itself, which on a stacked
# branch is the wrong baseline entirely and would pass a surface change that
# CI refuses.
#
# And it declines rather than failing when there is nothing to compare
# against. A fresh clone has no `origin/main`; the hook two steps below this
# one already degrades gracefully for exactly that case, and a guard that
# blocks every push on a machine that has not fetched is a guard people
# remove.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "surface-lock drift: no origin/main to compare against; skipped."
  echo "  (fetch it and re-run, or rely on the pull request's own check)"
  exit 0
fi

base="$(git merge-base origin/main HEAD)"
echo "surface-lock drift: comparing against $base"
exec pnpm --filter "@withmarfa/server" run surface-lock:drift "$base"
