#!/usr/bin/env bash
# Prepares a move of the pinned PDFium build. The weekly `pdfium-upkeep`
# workflow runs this.
#
# File reading pins PDFium in core/marfa-enrichment/native/manifest.txt: the
# bblanchon/pdfium-binaries commit that tagged release chromium/<N>, with the
# hash of its archive, and the head of PDFium's branch chromium/<N>. When the
# newest bblanchon release is at least MIN_DAYS newer than the pinned one, this
# writes the manifest for the newest release, pushes it to the branch
# automation/pdfium-chromium-<M>, and opens one issue titled
# "Move PDFium to chromium/<M>", or edits the open one whose title starts
# "Move PDFium to". Otherwise it prints that and does nothing.
#
# Every lookup must succeed. A lookup that fails fails the run: an error never
# reads as "nothing new".
#
# Usage: scripts/prepare-pdfium-move.sh [--dry-run] [--min-days N] [--manifest PATH]
#
#   --dry-run        Do every lookup and print the manifest diff, the branch and
#                    the issue; push, open and edit nothing.
#   --min-days N     Override the 28 days, to try the move path.
#   --manifest PATH  Read this manifest, not the checkout's own.
#
# The environment: GH_TOKEN and GITHUB_REPOSITORY (owner/name).
set -euo pipefail

MIN_DAYS=28
UPSTREAM=bblanchon/pdfium-binaries
BOT_NAME="github-actions[bot]"
BOT_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"

fail() {
  echo "prepare-pdfium-move: $*" >&2
  exit 1
}

dry_run=false
manifest=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --min-days)
      [[ $# -ge 2 ]] || fail "--min-days needs a number"
      MIN_DAYS=$2
      shift
      ;;
    --manifest)
      [[ $# -ge 2 ]] || fail "--manifest needs a path"
      manifest=$2
      shift
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done
[[ ${MIN_DAYS} =~ ^[0-9]+$ ]] || fail "--min-days must be a whole number"

: "${GH_TOKEN:?GH_TOKEN is not set}"
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}

root=$(git rev-parse --show-toplevel)
manifest_in_repo=core/marfa-enrichment/native/manifest.txt
manifest=${manifest:-${root}/${manifest_in_repo}}
[[ -f ${manifest} ]] || fail "no manifest at ${manifest}"

# The pin: `archive pdfium-binaries chromium/<N> <url> <sha256>`.
pinned_release=$(awk '$1 == "archive" && $2 == "pdfium-binaries" { print $3 }' "${manifest}")
[[ ${pinned_release} =~ ^chromium/[0-9]+$ ]] ||
  fail "the manifest has no single 'archive pdfium-binaries chromium/<N>' line (found '${pinned_release}')"
pinned=${pinned_release#chromium/}

pdfium_git_url=$(awk '$1 == "git" && $2 == "pdfium" { print $3 }' "${manifest}")
[[ ${pdfium_git_url} =~ ^https:// ]] ||
  fail "the manifest has no single 'git pdfium <url> ...' line (found '${pdfium_git_url}')"

# GitHub's own answers; each is checked, since a failed `gh` call must not
# become an empty value that reads as no news.
published_at() {
  gh api "repos/${UPSTREAM}/releases/tags/$1" | jq -er '.published_at | fromdateiso8601'
}

newest_release=$(gh api "repos/${UPSTREAM}/releases/latest" | jq -er '.tag_name')
[[ ${newest_release} =~ ^chromium/[0-9]+$ ]] || fail "the newest ${UPSTREAM} release is '${newest_release}', not chromium/<number>"
newest=${newest_release#chromium/}
newest_epoch=$(published_at "${newest_release}")
pinned_epoch=$(published_at "${pinned_release}")
newest_date=$(date -u -d "@${newest_epoch}" +%F 2>/dev/null || date -u -r "${newest_epoch}" +%F)
pinned_date=$(date -u -d "@${pinned_epoch}" +%F 2>/dev/null || date -u -r "${pinned_epoch}" +%F)
gap_days=$(((newest_epoch - pinned_epoch) / 86400))

echo "Pinned: ${pinned_release} (released ${pinned_date})"
echo "Newest: ${newest_release} (released ${newest_date})"
echo "Gap: ${gap_days} days; a move is prepared from ${MIN_DAYS}."

if ((newest <= pinned)); then
  echo "The pin is current. Nothing to do."
  exit 0
fi
if ((gap_days < MIN_DAYS)); then
  echo "The pin is less than ${MIN_DAYS} days behind. Nothing to do."
  exit 0
fi

# The commit that tagged the release. A lightweight tag points at the commit;
# an annotated tag points at a tag object that does.
ref_type=$(gh api "repos/${UPSTREAM}/git/ref/tags/${newest_release}" | jq -er '.object.type')
commit=$(gh api "repos/${UPSTREAM}/git/ref/tags/${newest_release}" | jq -er '.object.sha')
for _ in 1 2 3 4; do
  [[ ${ref_type} == tag ]] || break
  tag_object=$(gh api "repos/${UPSTREAM}/git/tags/${commit}")
  ref_type=$(jq -er '.object.type' <<<"${tag_object}")
  commit=$(jq -er '.object.sha' <<<"${tag_object}")
done
[[ ${ref_type} == commit ]] || fail "the tag ${newest_release} does not resolve to a commit"
[[ ${commit} =~ ^[0-9a-f]{40}$ ]] || fail "the tag ${newest_release} resolved to '${commit}', not a commit hash"

scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

archive_url="https://github.com/${UPSTREAM}/archive/${commit}.tar.gz"
curl --fail --silent --show-error --location --retry 3 --output "${scratch}/archive.tar.gz" "${archive_url}"
if command -v sha256sum >/dev/null; then
  archive_sha=$(sha256sum "${scratch}/archive.tar.gz" | awk '{ print $1 }')
else
  archive_sha=$(shasum -a 256 "${scratch}/archive.tar.gz" | awk '{ print $1 }')
fi
[[ ${archive_sha} =~ ^[0-9a-f]{64}$ ]] || fail "could not hash the archive at ${archive_url}"

# The head of PDFium's branch for the release. A branch that does not resolve
# to exactly one commit stops the move.
branch_head=$(git ls-remote "${pdfium_git_url}" "refs/heads/chromium/${newest}")
[[ $(wc -l <<<"${branch_head}") -eq 1 && ${branch_head} =~ ^[0-9a-f]{40}[[:space:]] ]] ||
  fail "PDFium's branch chromium/${newest} did not resolve to one commit (got '${branch_head}')"
pdfium_commit=${branch_head%%[[:space:]]*}

# The moved manifest: both pins, and the release number wherever a comment in a
# block of comments about PDFium names the old one (a block runs to the next
# line that is not a comment).
PINNED=${pinned} NEWEST=${newest} COMMIT_URL=${archive_url} SHA=${archive_sha} PDFIUM_COMMIT=${pdfium_commit} \
  perl -pe '
    my ($n, $m) = ($ENV{PINNED}, $ENV{NEWEST});
    if (/^archive pdfium-binaries /) {
      $_ = "archive pdfium-binaries chromium/$m $ENV{COMMIT_URL} $ENV{SHA}\n";
    } elsif (/^git pdfium /) {
      my @f = split " ";
      $_ = "git pdfium $f[2] chromium/$m $ENV{PDFIUM_COMMIT}\n";
    } elsif (/^#/) {
      $in_pdfium = 1 if /pdfium/i;
      s/(?<!\w)\Q$n\E(?!\w)/$m/g if $in_pdfium;
    } else {
      $in_pdfium = 0;
    }
  ' "${manifest}" >"${scratch}/manifest.txt"

moved_mentions=$(grep -cE "(^|[^[:alnum:]_])${pinned}([^[:alnum:]_]|$)" "${scratch}/manifest.txt" || true)
[[ ${moved_mentions} -eq 0 ]] || fail "the moved manifest still names ${pinned} in ${moved_mentions} lines"
[[ $(grep -c "chromium/${newest}" "${scratch}/manifest.txt") -ge 2 ]] || fail "the moved manifest does not carry chromium/${newest} on both pins"

branch="automation/pdfium-chromium-${newest}"
title="Move PDFium to chromium/${newest}"
compare_url="https://github.com/${repo}/compare/main...${branch}?expand=1"
branch_url="https://github.com/${repo}/tree/${branch}"

body="${scratch}/body.md"
cat >"${body}" <<EOF
## Summary

PDFium reads untrusted files, so the pin moves at least monthly. The pinned build is ${gap_days} days behind the newest one, which is past the ${MIN_DAYS} days the weekly check waits. The manifest for the newest build is ready on a branch.

## Context

- Pinned: \`${pinned_release}\`, released ${pinned_date}.
- Newest: \`${newest_release}\`, released ${newest_date}.
- Branch: [\`${branch}\`](${branch_url}).
- Open the pull request: ${compare_url}
- The branch changes \`${manifest_in_repo}\` only: the \`pdfium-binaries\` archive (commit \`${commit}\`, hash \`${archive_sha}\`) and the PDFium branch head (\`${pdfium_commit}\`).

## Acceptance criteria

- The pull request from the branch passes its \`Core native (x86_64 Linux)\` job: it builds PDFium from the new pins, verifies the sandbox and fuzzes the reader.
- If that build fails because \`pdfium-render\` in \`core/marfa-enrichment/Cargo.toml\` has no API for this PDFium, the same pull request moves \`pdfium-render\`.
- The pull request merges only after that job passes.

## Out of scope

- Tesseract, Leptonica and the Rust toolchain.

## Notes

The move lands only through a pull request: GitHub Actions cannot open one in this repository, and a pull request opened with the workflow's token would start no CI. A mismatch between \`pdfium-render\` and the new PDFium fails the static link in the native build. The weekly check rewrites this issue and the branch while a newer build appears, and opens no pull request.
EOF

echo
echo "Branch: ${branch}"
echo "Issue: ${title}"
echo
echo "Manifest diff:"
diff -u --label "a/${manifest_in_repo}" --label "b/${manifest_in_repo}" "${manifest}" "${scratch}/manifest.txt" || [[ $? -eq 1 ]]
echo
echo "Issue body:"
cat "${body}"
echo

# An open issue whose title starts "Move PDFium to" is the one to edit, a
# stale one included: it names a build that has been passed.
open=$(
  gh issue list --repo "${repo}" --state open --limit 100 \
    --search '"Move PDFium to" in:title' --json number,title |
    jq -r '[.[] | select(.title | startswith("Move PDFium to"))][0].number // empty'
) || fail "could not list the open issues"

if ${dry_run}; then
  if [[ -n ${open} ]]; then
    echo "Dry run: would push ${branch} and edit issue ${open}."
  else
    echo "Dry run: would push ${branch} and open the issue."
  fi
  exit 0
fi

# The commit takes its date from the commit it is made on, so the same move
# from the same base is the same commit and a weekly rerun pushes nothing new.
base_date=$(git -C "${root}" log -1 --format=%cI HEAD)
cp "${scratch}/manifest.txt" "${root}/${manifest_in_repo}"
git -C "${root}" switch --quiet --force-create "${branch}"
git -C "${root}" add -- "${manifest_in_repo}"
GIT_AUTHOR_NAME=${BOT_NAME} GIT_AUTHOR_EMAIL=${BOT_EMAIL} GIT_AUTHOR_DATE=${base_date} \
  GIT_COMMITTER_NAME=${BOT_NAME} GIT_COMMITTER_EMAIL=${BOT_EMAIL} GIT_COMMITTER_DATE=${base_date} \
  git -C "${root}" commit --quiet -m "chore(core): move PDFium to chromium/${newest}"
# Forced, and only this branch: it is the workflow's own.
git -C "${root}" push --force origin "HEAD:refs/heads/${branch}"

if [[ -n ${open} ]]; then
  gh issue edit "${open}" --repo "${repo}" --title "${title}" --body-file "${body}"
  echo "Edited issue ${open}."
else
  gh issue create --repo "${repo}" --title "${title}" --label core --body-file "${body}"
fi
