#!/usr/bin/env bash
# Stamps one version into every manifest. `release.yml` runs it in its own checkout;
# run by hand it leaves a tree that `ci/version-fields.test.ts` refuses.
#
# Every manifest is checked before any is written. A failure in `cargo update`,
# after the writes, leaves the tree stamped.
set -euo pipefail

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: stamp-version.sh <version>" >&2
  exit 2
fi
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

# Never a `version` key under a dependency table.
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

# Offline: a stamp must not reach for the registry.
while IFS= read -r lock; do
  (cd "$(dirname "$lock")" && cargo update --workspace --offline --quiet)
  echo "$lock: $version"
done < <(git ls-files -- '*Cargo.lock')
