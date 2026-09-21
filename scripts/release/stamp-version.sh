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
# packed tarballs, the crate, the workspace's private packages.
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

for dir in packages/* conformance core/bindings/node; do
  [ -f "$dir/package.json" ] || continue
  current="$(node -p "require('./$dir/package.json').version ?? ''")"
  if [ "$current" != "$placeholder" ]; then
    echo "stamp-version: $dir/package.json carries '$current', not the placeholder" >&2
    exit 1
  fi
  (cd "$dir" && npm pkg set version="$version")
  echo "$dir/package.json: $version"
done

for manifest in core/Cargo.toml core/bindings/swift/Cargo.toml; do
  if ! grep -q "^version = \"$placeholder\"$" "$manifest"; then
    echo "stamp-version: $manifest carries no placeholder version line" >&2
    exit 1
  fi
  sed -i.stamp "s/^version = \"$placeholder\"$/version = \"$version\"/" "$manifest"
  rm "$manifest.stamp"
  echo "$manifest: $version"
done

# The lock files record the workspace crates' own versions; cargo rewrites
# them from the manifests. Offline, because the dependencies are already
# resolved and a stamp must not reach for the registry.
(cd core && cargo update --workspace --offline --quiet)
(cd core/bindings/swift && cargo update --workspace --offline --quiet)
echo "Cargo.lock: $version"
