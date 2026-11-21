#!/usr/bin/env bash
# Unpacks a release archive and runs its programs, so it needs the archive's architecture.
#
#   check-archive.sh <archive> <version> [--boot]
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
for program in marfa marfa-server; do
  reported=$("$work/$program" --version)
  if [ "$reported" != "$program $version" ]; then
    echo "::error::$program in $(basename "$archive") reports '$reported', not '$program $version'."
    exit 1
  fi
  echo "$(basename "$archive"): $reported"
done

# The connector is Cloudflare's, so its version is the pin's and its bytes are the pinned program's.
connector=$(pin_of version)
target=$(target_of_this_machine)
download=$(pin_download "$target")
read -r _ _ want <<< "$download"
if command -v sha256sum > /dev/null 2>&1; then
  have=$(sha256sum "$work/cloudflared" | cut -d' ' -f1)
else
  have=$(shasum -a 256 "$work/cloudflared" | cut -d' ' -f1)
fi
if [ "$have" != "$want" ]; then
  echo "::error::cloudflared in $(basename "$archive") is $have, not the $want that cloudflared.txt names."
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
