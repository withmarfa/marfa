#!/usr/bin/env bash
# Unpacks a release archive and runs its programs, so it needs the archive's architecture.
#
#   check-archive.sh <archive> <version> [--boot]
#
# MARFA_EXPECT_TEAM names the Apple team every program must be signed by, in a tag run.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=cloudflared-pins.sh
source "$here/cloudflared-pins.sh"

archive="$1"
version="$2"
boot="${3:-}"

listed=$(tar -tzf "$archive" | LC_ALL=C sort)
if [ "$listed" != "$(printf '%s\n' NOTICES.txt cloudflared marfa marfa-server)" ]; then
  echo "::error::$(basename "$archive") does not hold exactly marfa, marfa-server, cloudflared and NOTICES.txt:"
  echo "$listed"
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
# Where macOS signs programs, every program in the archive carries a valid signature, and with
# MARFA_EXPECT_TEAM set, the release's own, under the hardened runtime.
if command -v codesign > /dev/null 2>&1; then
  for program in marfa marfa-server cloudflared; do
    if ! codesign --verify --strict "$work/$program"; then
      echo "::error::$program in $(basename "$archive") has no valid signature."
      exit 1
    fi
    if [ -n "${MARFA_EXPECT_TEAM:-}" ]; then
      details=$(codesign -dv "$work/$program" 2>&1)
      if ! grep -qx "TeamIdentifier=$MARFA_EXPECT_TEAM" <<< "$details" || ! grep -q '(runtime)' <<< "$details"; then
        echo "::error::$program in $(basename "$archive") is not signed by team $MARFA_EXPECT_TEAM under the hardened runtime:"
        echo "$details"
        exit 1
      fi
    fi
  done
  echo "$(basename "$archive"): every program is signed"
fi

for program in marfa marfa-server; do
  reported=$("$work/$program" --version)
  if [ "$reported" != "$program $version" ]; then
    echo "::error::$program in $(basename "$archive") reports '$reported', not '$program $version'."
    exit 1
  fi
  echo "$(basename "$archive"): $reported"
done

# The connector is Cloudflare's, so its version is the pin's. Its macOS bytes are not the pinned
# program's, since the release signs it again, so the pinned hash is no check on them.
connector=$(pin_of version)
if [ ! -x "$work/cloudflared" ]; then
  echo "::error::cloudflared in $(basename "$archive") is not an executable file."
  exit 1
fi
reported=$("$work/cloudflared" --version)
case "$reported" in
  "cloudflared version $connector "*) ;;
  *)
    echo "::error::cloudflared in $(basename "$archive") reports '$reported', not version $connector."
    exit 1
    ;;
esac
echo "$(basename "$archive"): $reported"

if [ "$boot" = "--boot" ]; then
  bash "$here/boot-server.sh" "$work/marfa-server"
elif [ -n "$boot" ]; then
  echo "check-archive: unknown option $boot" >&2
  exit 2
fi
