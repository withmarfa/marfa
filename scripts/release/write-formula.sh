#!/usr/bin/env bash
# Write the Homebrew formula for the `marfa` command line of one release to
# standard output, from the release's checksum file (`write-checksums.sh`
# writes it). Refuses a version that is not three numbers, and a checksum file
# that lacks either macOS archive, names it twice, or gives it anything but 64
# lowercase hexadecimal digits.
#
#   write-formula.sh <version> <checksum file>
set -euo pipefail

version="$1"
checksums="$2"

if ! [[ "$version" =~ ^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$ ]]; then
  echo "::error::'$version' is not a release version (three numbers, such as 0.0.22)." >&2
  exit 1
fi

# The hash of one archive, which must be on exactly one line.
hash_of() {
  local archive="$1" lines
  lines=$(awk -v name="$archive" '$2 == name' "$checksums")
  if [ -z "$lines" ]; then
    echo "::error::$checksums has no line for $archive." >&2
    return 1
  fi
  if [ "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" != 1 ]; then
    echo "::error::$checksums names $archive more than once." >&2
    return 1
  fi
  local hash="${lines%% *}"
  if ! [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::The checksum of $archive is not 64 lowercase hexadecimal digits." >&2
    return 1
  fi
  printf '%s' "$hash"
}

arm=$(hash_of "marfa-$version-darwin-arm64.tar.gz")
intel=$(hash_of "marfa-$version-darwin-x86_64.tar.gz")
base="https://github.com/withmarfa/marfa/releases/download/v$version"

cat <<FORMULA
# Written by the release workflow of withmarfa/marfa from the release's
# checksum file. A change made here by hand is replaced by the next release.
class Marfa < Formula
  desc "Command-line interface for Marfa, a self-hosted personal data store"
  homepage "https://github.com/withmarfa/marfa"
  license "Apache-2.0"

  depends_on :macos

  on_macos do
    on_arm do
      url "$base/marfa-$version-darwin-arm64.tar.gz"
      sha256 "$arm"
    end
    on_intel do
      url "$base/marfa-$version-darwin-x86_64.tar.gz"
      sha256 "$intel"
    end
  end

  def install
    bin.install "marfa"
  end

  def caveats
    <<~EOS
      Set up a server on this machine with Docker:
        marfa server install
    EOS
  end

  test do
    assert_match "marfa #{version}", shell_output("#{bin}/marfa --version")
  end
end
FORMULA
