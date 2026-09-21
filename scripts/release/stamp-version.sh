#!/usr/bin/env bash
# Stamp one product version into every manifest.
#
# The only writer of a version. The release workflow runs it in its own
# checkout after reading the tag, and nothing commits the result: every
# manifest in the repository carries the placeholder `0.0.0`, and
# `ci/version-fields.test.ts` refuses a tree where one does not. Run by hand
# it leaves a tree that check refuses, which is the point: a version is a
# fact about a tag, not about a branch.
#
# Every manifest is stamped, not only the published ones, so one build
# reports one number everywhere it can be asked: `marfa --version`, the
# packed tarballs, the crate, the workspace's private packages. The
# manifests are the tracked ones, listed the way the check lists them, so
# the two cannot disagree about which files are manifests; a manifest with
# no placeholder to replace stops the stamp rather than being skipped.
set -euo pipefail

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: stamp-version.sh <version>" >&2
  exit 2
fi
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "stamp-version: '$version' is not a semver version" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

placeholder='0.0.0'

while IFS= read -r manifest; do
  # The root is the workspace, not a package, and holds no version.
  [ "$manifest" = "package.json" ] && continue
  dir="$(dirname "$manifest")"
  current="$(node -p "require('./$manifest').version ?? ''")"
  if [ "$current" != "$placeholder" ]; then
    echo "stamp-version: $manifest carries '$current', not the placeholder" >&2
    exit 1
  fi
  (cd "$dir" && npm pkg set version="$version")
  echo "$manifest: $version"
done < <(git ls-files -- '*package.json')

while IFS= read -r manifest; do
  if grep -q '^version\.workspace = true' "$manifest"; then
    continue
  fi
  if ! grep -q "^version = \"$placeholder\"$" "$manifest"; then
    echo "stamp-version: $manifest carries no placeholder version line" >&2
    exit 1
  fi
  sed -i.stamp "s/^version = \"$placeholder\"$/version = \"$version\"/" "$manifest"
  rm "$manifest.stamp"
  echo "$manifest: $version"
done < <(git ls-files -- '*Cargo.toml')

# The lock files record the workspace crates' own versions; cargo rewrites
# them from the manifests. Offline, because the dependencies are already
# resolved and a stamp must not reach for the registry.
while IFS= read -r lock; do
  (cd "$(dirname "$lock")" && cargo update --workspace --offline --quiet)
  echo "$lock: $version"
done < <(git ls-files -- '*Cargo.lock')
