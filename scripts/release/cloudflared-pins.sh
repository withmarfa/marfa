#!/usr/bin/env bash
# Reads `cloudflared.txt`. Sourced by the scripts that fetch and check the connector, never run.
#
# MARFA_CLOUDFLARED_PINS names another pin file, for the scripts' own tests.

pins_file=${MARFA_CLOUDFLARED_PINS:-$(dirname "${BASH_SOURCE[0]}")/cloudflared.txt}

# pin_of <kind>: the one value on the file's `<kind>` line.
pin_of() {
  local value
  value=$(awk -v kind="$1" '$1 == kind { print $2 }' "$pins_file")
  if [ -z "$value" ] || [ "$(printf '%s\n' "$value" | wc -l | tr -d ' ')" != 1 ]; then
    echo "::error::$pins_file does not name exactly one '$1' line." >&2
    return 1
  fi
  printf '%s' "$value"
}

# pin_download <target>: the target's asset, download hash and program hash, as three words.
pin_download() {
  local line
  line=$(awk -v target="$1" '$1 == "download" && $2 == target { print $3, $4, $5 }' "$pins_file")
  if [ -z "$line" ] || [ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" != 1 ]; then
    echo "::error::$pins_file does not name exactly one download for $1." >&2
    return 1
  fi
  printf '%s' "$line"
}
