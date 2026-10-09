#!/usr/bin/env bash
# Reports a failed scheduled run. The `report-failure` job of each scheduled
# workflow runs this, after a job of the workflow failed.
#
# One issue stays open per workflow, titled "Nightly failed: <workflow>". The
# first failure opens it and each failure after that comments on it, so a
# workflow that stays red for a week is one issue and not seven.
#
# It runs under the workflow's token, so it reads the run's own environment.
# Every `gh` call must succeed: a report that cannot be made fails this job,
# which shows in the run, instead of passing with nothing reported.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is not set}"
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}
workflow=${GITHUB_WORKFLOW:?GITHUB_WORKFLOW is not set}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is not set}
sha=${GITHUB_SHA:?GITHUB_SHA is not set}
run_url="${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${run_id}"
title="Nightly failed: ${workflow}"

failed=$(
  gh run view "${run_id}" --repo "${repo}" --json jobs |
    jq -r '[.jobs[] | select(.conclusion == "failure") | "- " + .name] | join("\n")'
)
if [[ -z "${failed}" ]]; then
  failed="- None ended as failed. A job may have been cancelled or timed out."
fi

# The search matches words, not the whole title, so only an exact title counts.
open=$(
  gh issue list --repo "${repo}" --state open --limit 100 \
    --search "\"${title}\" in:title" --json number,title |
    jq -r --arg title "${title}" '[.[] | select(.title == $title)][0].number // empty'
)

if [[ -n "${open}" ]]; then
  gh issue comment "${open}" --repo "${repo}" --body "The scheduled run failed again: ${run_url}

Commit: \`${sha}\`

Failed jobs:

${failed}"
  echo "Commented on issue ${open}."
  exit 0
fi

body=$(mktemp)
trap 'rm -f "${body}"' EXIT
cat >"${body}" <<EOF
## Summary

The scheduled run of the ${workflow} workflow failed. The cause is not known yet.

## Context

- Run: ${run_url}
- Commit: \`${sha}\`
- Failed jobs:

${failed}

## Acceptance criteria

- The nightly run passes.

## Out of scope

- Jobs that passed in this run.

## Notes

This issue was opened by the workflow. Each later failure of the scheduled run comments here until the issue is closed.
EOF

gh issue create --repo "${repo}" --title "${title}" \
  --label needs-triage --label ci --body-file "${body}"
