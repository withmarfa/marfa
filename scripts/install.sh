#!/bin/sh
# Install the `marfa` command line from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/withmarfa/marfa/main/scripts/install.sh | sh
#
# It picks the archive for this machine, checks it against the release's
# checksum file, and puts `marfa` in one folder. Running it again installs
# the latest release over the last, or leaves the install as it is.
#
#   MARFA_VERSION      a release such as 0.0.23; the latest when not set
#   MARFA_INSTALL_DIR  where marfa goes; ~/.local/bin when not set
#
# MARFA_DOWNLOAD_BASE replaces the release address, for the script's own tests.
set -eu

repo="withmarfa/marfa"
say() { printf '%s\n' "$*"; }
fail() {
  printf 'marfa install: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is not installed."
command -v tar >/dev/null 2>&1 || fail "tar is not installed."

# The archive's name for this machine.
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "$(uname -s) is not supported. Marfa's command line runs on macOS and Linux." ;;
esac
arch=$(uname -m)
case "$os:$arch" in
  darwin:arm64 | darwin:aarch64) arch=arm64 ;;
  darwin:x86_64 | darwin:amd64)
    # A shell run under Rosetta on an Apple silicon Mac reports x86_64.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
      arch=arm64
    else
      arch=x86_64
    fi
    ;;
  linux:x86_64 | linux:amd64) arch=x86_64 ;;
  linux:aarch64 | linux:arm64) arch=aarch64 ;;
  *) fail "$arch is not supported on $os." ;;
esac

# The release: named, or the latest, which GitHub answers with a redirect to
# its tag.
version="${MARFA_VERSION:-}"
if [ -z "$version" ]; then
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
    fail "could not ask GitHub for the latest release."
  version="${tag##*/v}"
fi
case "$version" in
  *[!0-9.]* | '' | .* | *. | *..*) fail "'$version' is not a release such as 0.0.23." ;;
esac

base="${MARFA_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/v$version}"
archive="marfa-$version-$os-$arch.tar.gz"
sums="marfa-$version-checksums.txt"

dir="${MARFA_INSTALL_DIR:-$HOME/.local/bin}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

say "Downloading marfa $version for $os $arch..."
curl -fsSL -o "$work/$archive" "$base/$archive" 2>/dev/null ||
  fail "could not download $archive from $base. Check that release $version exists and carries it."
curl -fsSL -o "$work/$sums" "$base/$sums" 2>/dev/null ||
  fail "could not download $sums, so the archive cannot be checked. Nothing was installed."

# The archive must match its line in the checksum file, exactly once.
expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$work/$sums")
[ -n "$expected" ] || fail "$sums has no line for $archive. Nothing was installed."
[ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" = 1 ] ||
  fail "$sums names $archive more than once. Nothing was installed."
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$archive" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)
else
  fail "neither sha256sum nor shasum is installed, so the archive cannot be checked."
fi
[ "$actual" = "$expected" ] ||
  fail "the checksum of $archive does not match the release's. Nothing was installed."

mkdir "$work/unpack"
tar -xzf "$work/$archive" -C "$work/unpack"
[ -f "$work/unpack/marfa" ] || fail "$archive holds no marfa. Nothing was installed."
chmod +x "$work/unpack/marfa"
reported=$("$work/unpack/marfa" --version) ||
  fail "the downloaded marfa does not run on this machine. Nothing was installed."
[ "$reported" = "marfa $version" ] ||
  fail "the downloaded marfa reports '$reported', not 'marfa $version'. Nothing was installed."

mkdir -p "$dir" || fail "could not make $dir. Choose another with MARFA_INSTALL_DIR."
# A copy beside the target and a rename, so a stop part-way leaves the old one.
cp "$work/unpack/marfa" "$dir/.marfa.$$" || fail "could not write to $dir. Choose another with MARFA_INSTALL_DIR."
mv "$dir/.marfa.$$" "$dir/marfa"
say "Installed marfa $version to $dir/marfa."

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    say ""
    say "$dir is not on your PATH. Add it to your shell's startup file:"
    say "  export PATH=\"$dir:\$PATH\""
    ;;
esac
say ""
say "Set up a server on this machine, with Docker installed:"
say "  marfa server install"
