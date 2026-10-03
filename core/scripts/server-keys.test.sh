#!/usr/bin/env bash
set -euo pipefail
umask 022

scripts="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-server-keys.XXXXXX")"
export MARFA_SERVER_KEEP="${work}/server"
export MARFA_SERVER_ENV="${work}/server.env"
: >"${MARFA_SERVER_ENV}"
trap '"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}" >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

check_key() {
  curl -fsS --max-time 10 "${MARFA_TEST_URL}/keys/current" \
    -H "Authorization: Bearer $1" |
    python3 -c 'import json,sys
key = json.load(sys.stdin)
assert key["is_operator"] == (sys.argv[1] == "operator"), "wrong key role"' "$2"
}

up() {
  local env_text
  unset MARFA_TEST_KEY MARFA_TEST_OPERATOR_KEY
  env_text="$("${scripts}/server-up.sh")"
  eval "${env_text}"
  : "${MARFA_TEST_KEY:?working key was not exported}"
  : "${MARFA_TEST_OPERATOR_KEY:?operator key was not exported}"
  [[ "${MARFA_TEST_KEY}" != "${MARFA_TEST_OPERATOR_KEY}" ]]
  python3 - "${MARFA_SERVER_ENV}" "${MARFA_SERVER_KEEP}/boot.env" <<'PY'
import os, stat, sys
for path in sys.argv[1:]:
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600, "credential file is not private"
PY
  check_key "${MARFA_TEST_KEY}" working
  check_key "${MARFA_TEST_OPERATOR_KEY}" operator
}

up
first_working="${MARFA_TEST_KEY}"
first_operator="${MARFA_TEST_OPERATOR_KEY}"
"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}"
chmod 644 "${MARFA_SERVER_KEEP}/boot.env"
: >"${MARFA_SERVER_ENV}"
chmod 644 "${MARFA_SERVER_ENV}"
up
[[ "${MARFA_TEST_KEY}" == "${first_working}" ]]
[[ "${MARFA_TEST_OPERATOR_KEY}" == "${first_operator}" ]]
echo "Both key roles survive a kept-server restart."

"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}"
python3 - "${MARFA_SERVER_KEEP}/boot.env" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text("".join(line for line in path.read_text().splitlines(keepends=True)
                        if not line.startswith("BOOT_OPERATOR_KEY=")))
PY
if "${scripts}/server-up.sh" >"${work}/missing.out" 2>"${work}/missing.err"; then
  echo "server-up accepted kept state with no operator key" >&2
  exit 1
fi
[[ ! -s "${work}/missing.out" ]]
grep -q 'kept state has no operator key' "${work}/missing.err"
if curl -fsS --max-time 2 "${MARFA_TEST_URL}/health" >/dev/null 2>&1; then
  echo "server-up started a server before refusing incomplete kept state" >&2
  exit 1
fi
echo "Incomplete kept state is refused before starting a server."
