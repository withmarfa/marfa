#!/usr/bin/env bash
# Refuses a release commit that no green `core.yml` run vouches for.
#
# `core.yml` runs the core's live checks on macOS for a push to `main` that
# touches the core, the nightly and a dispatch, so most commits have no run of
# their own. A commit is vouched for by the nearest run at or before it, and
# only when no commit since changed a path that run reads.
#
# Needs GITHUB_SHA, GITHUB_REPOSITORY and an authenticated `gh` and `jq`.
set -euo pipefail

sha="${GITHUB_SHA:?}"
repo="${GITHUB_REPOSITORY:?}"
workflow="repos/$repo/actions/workflows/core.yml/runs"

fail() {
  echo "::error::$*"
  exit 1
}

# The paths of `core.yml`'s push filter; `ci/release-core-run.test.ts` holds
# them to the workflow's own list.
affects_core() {
  local file
  while IFS= read -r file; do
    case "$file" in
      *.md) ;;
      core/* | openapi.json | package.json | .github/workflows/core.yml | .github/workflows/core-live.yml) return 0 ;;
    esac
  done
  return 1
}

# The runs on `main` and any run on this very commit (a dry run on a branch),
# newest first. A run for a commit that is not an ancestor is passed over below.
runs=$(
  {
    gh api "$workflow?branch=main&per_page=100"
    gh api "$workflow?head_sha=$sha&per_page=100"
  } | jq -s '[.[].workflow_runs[]] | unique_by(.id) | sort_by(.created_at) | reverse'
)

nearest=""
changed=""
truncated=false
while read -r candidate; do
  [ -n "$candidate" ] || continue
  comparison=$(gh api "repos/$repo/compare/$candidate...$sha?per_page=100")
  case "$(jq -r .status <<< "$comparison")" in
    identical | ahead)
      nearest="$candidate"
      changed=$(jq -r '.files[].filename' <<< "$comparison")
      # A comparison that fills its page may hold more files than it lists.
      [ "$(jq '.files | length' <<< "$comparison")" -lt 100 ] || truncated=true
      break
      ;;
  esac
done < <(jq -r 'reduce .[].head_sha as $s ([]; if index($s) then . else . + [$s] end) | .[]' <<< "$runs")

if [ -z "$nearest" ]; then
  fail "No core.yml run at or before $sha among the latest runs on main. A release waits for a green run of the core's live checks."
fi

if [ "$nearest" != "$sha" ]; then
  if [ "$truncated" = true ] || affects_core <<< "$changed"; then
    fail "No core.yml run for $sha, and a commit since $nearest, the nearest run, changed what the core's live checks read. Wait for its run to appear, or run core.yml by hand on $sha."
  fi
fi

states=$(jq -r --arg sha "$nearest" '[.[] | select(.head_sha == $sha) | "\(.id) \(.status) \(.conclusion // "none")"] | .[]' <<< "$runs")
if grep -q ' completed success$' <<< "$states"; then
  echo "core.yml is green for $nearest, which covers $sha"
  exit 0
fi
if grep -qv ' completed ' <<< "$states"; then
  fail "core.yml is still running for $nearest (run $(grep -v ' completed ' <<< "$states" | head -1 | cut -d' ' -f1)); this release needs it green. Re-run this job when it has finished."
fi
fail "core.yml did not pass for $nearest: run $(head -1 <<< "$states" | cut -d' ' -f1) ended $(head -1 <<< "$states" | cut -d' ' -f3). A release refuses a commit whose live checks failed."
