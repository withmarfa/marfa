#!/usr/bin/env bash
# Stamp one product version into every manifest.
#
# The only writer of a version. `release.yml` runs it in its own checkout
# after reading the tag, and nothing on a branch runs it: every manifest in
# the repository carries the placeholder `0.0.0`, and
# `ci/version-fields.test.ts` refuses a tree where one does not. Run by hand
# it leaves a tree that check refuses, which is the point: a version is a
# fact about a tag, not about a branch.
#
# Every manifest is stamped, not only the published ones, so one build
# reports one number everywhere it can be asked: `marfa --version`, the
# packed tarballs and the workspace's private packages. The
# manifests are the tracked ones, listed the way the check lists them, so
# the two cannot disagree about which files are manifests. Every manifest is
# checked before any is written, so a version or a manifest this script
# refuses leaves the tree as it was rather than half stamped. A failure after
# the writes, in `cargo update`, does not: the checkout is the workflow's and
# is thrown away with the failed run.
set -euo pipefail

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: stamp-version.sh <version>" >&2
  exit 2
fi
# A release is major.minor.patch and nothing more: every version is the one
# before it plus 0.0.1, so a pre-release has no place, and the placeholder
# is what a build that was never stamped carries, so it is never a release.
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "stamp-version: '$version' is not major.minor.patch" >&2
  exit 2
fi
if [ "$version" = "0.0.0" ]; then
  echo "stamp-version: 0.0.0 is the placeholder, never a release" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

placeholder='0.0.0'

packages=()
while IFS= read -r manifest; do
  # The root is the workspace, not a package, and holds no version.
  [ "$manifest" = "package.json" ] && continue
  current="$(node -p "require('./$manifest').version ?? ''")"
  if [ "$current" != "$placeholder" ]; then
    echo "stamp-version: $manifest carries '$current', not the placeholder; nothing stamped" >&2
    exit 1
  fi
  packages+=("$manifest")
done < <(git ls-files -- '*package.json')

# The crate's own version line: the first `version` key under `[package]` or
# `[workspace.package]`, never one under a dependency table.
package_version_line() {
  awk '/^\[/ { own = ($0 == "[package]" || $0 == "[workspace.package]") }
       own && /^version[ .]/ { print; exit }' "$1"
}

crates=()
while IFS= read -r manifest; do
  line="$(package_version_line "$manifest")"
  if [ "$line" = "version.workspace = true" ]; then
    continue
  fi
  if [ "$line" != "version = \"$placeholder\"" ]; then
    echo "stamp-version: $manifest carries no placeholder version line; nothing stamped" >&2
    exit 1
  fi
  crates+=("$manifest")
done < <(git ls-files -- '*Cargo.toml')

# Rewritten in place with the version and nothing else changed: `JSON.parse`
# keeps key order, and assigning an existing key keeps its position.
for manifest in "${packages[@]}"; do
  node -e '
    const fs = require("node:fs");
    const [path, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.version = version;
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ' "$manifest" "$version"
  echo "$manifest: $version"
done

for manifest in "${crates[@]}"; do
  awk -v from="version = \"$placeholder\"" -v to="version = \"$version\"" '
    /^\[/ { own = ($0 == "[package]" || $0 == "[workspace.package]") }
    own && !done && $0 == from { print to; done = 1; next }
    { print }' "$manifest" > "$manifest.stamp"
  mv "$manifest.stamp" "$manifest"
  echo "$manifest: $version"
done

# The lock files record the workspace crates' own versions; cargo rewrites
# them from the manifests. Offline, because the dependencies are already
# resolved and a stamp must not reach for the registry.
while IFS= read -r lock; do
  (cd "$(dirname "$lock")" && cargo update --workspace --offline --quiet)
  echo "$lock: $version"
done < <(git ls-files -- '*Cargo.lock')
