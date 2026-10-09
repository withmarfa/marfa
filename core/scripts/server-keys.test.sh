#!/usr/bin/env bash
set -euo pipefail
umask 022

scripts="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "/tmp/marfa-server-keys.XXXXXX")"
export MARFA_SERVER_KEEP="${work}/server"
export MARFA_SERVER_ENV="${work}/server.env"
: >"${MARFA_SERVER_ENV}"
trap '"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}" >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

check_key() {
  printf 'Authorization: Bearer %s\n' "$1" |
    curl -fsS --max-time 10 "${MARFA_TEST_URL}/keys/current" -H @- |
    python3 -c 'import json,sys
key = json.load(sys.stdin)
assert "keys.mint" in key["permissions"], "missing working permission"
assert "instance.read" in key["permissions"], "missing explicit management permission"'
}

# The sign-in form trusts the issuer's own origin, which the discovery document
# names and which need not be the address the server was booted on.
check_owner() {
  local body origin
  origin="$(curl -fsS --max-time 10 "${MARFA_TEST_URL}/auth/.well-known/oauth-authorization-server" |
    python3 -c 'import json,sys; from urllib.parse import urlparse
issuer = urlparse(json.load(sys.stdin)["issuer"])
print(f"{issuer.scheme}://{issuer.netloc}")')"
  body="$(python3 -c 'import json,os; print(json.dumps({"email":os.environ["MARFA_TEST_OWNER_EMAIL"],"password":os.environ["MARFA_TEST_OWNER_PASSWORD"]}))')"
  curl -fsS --max-time 10 -X POST "${MARFA_TEST_URL}/auth/sign-in/email" \
    -H 'Content-Type: application/json' \
    -H "Origin: ${origin}" \
    --data-binary @- <<<"${body}" |
    python3 -c 'import json,sys
answer = json.load(sys.stdin)
assert answer.get("user", {}).get("email") == sys.argv[1], "the owner did not sign in"' "${MARFA_TEST_OWNER_EMAIL}"
}

up() {
  local env_text
  unset MARFA_TEST_KEY MARFA_TEST_SOCKET MARFA_TEST_OWNER_EMAIL MARFA_TEST_OWNER_PASSWORD
  env_text="$("${scripts}/server-up.sh")"
  eval "${env_text}"
  : "${MARFA_TEST_KEY:?working key was not exported}"
  : "${MARFA_TEST_SOCKET:?control socket was not exported}"
  [[ -S "${MARFA_TEST_SOCKET}" ]]
  python3 - "${MARFA_SERVER_ENV}" "${MARFA_SERVER_KEEP}/boot.env" <<'PY'
import os, stat, sys
for path in sys.argv[1:]:
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600, "credential file is not private"
PY
  : "${MARFA_TEST_OWNER_EMAIL:?the test owner was not exported}"
  : "${MARFA_TEST_OWNER_PASSWORD:?the test owner password was not exported}"
  check_key "${MARFA_TEST_KEY}"
  curl -fsS --unix-socket "${MARFA_TEST_SOCKET}" http://localhost/_control/setup/status |
    python3 -c 'import json,sys; assert json.load(sys.stdin)["claimed"]'
  check_owner
}

up
first_working="${MARFA_TEST_KEY}"
first_socket="${MARFA_TEST_SOCKET}"
first_owner="${MARFA_TEST_OWNER_EMAIL}:${MARFA_TEST_OWNER_PASSWORD}"
"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}"
chmod 644 "${MARFA_SERVER_KEEP}/boot.env"
: >"${MARFA_SERVER_ENV}"
chmod 644 "${MARFA_SERVER_ENV}"
up
[[ "${MARFA_TEST_KEY}" == "${first_working}" ]]
[[ "${MARFA_TEST_SOCKET}" == "${first_socket}" ]]
[[ "${MARFA_TEST_OWNER_EMAIL}:${MARFA_TEST_OWNER_PASSWORD}" == "${first_owner}" ]]
echo "The working key, private control socket and test owner survive a kept-server restart."

"${scripts}/server-down.sh" "${MARFA_SERVER_ENV}"
python3 - "${MARFA_SERVER_KEEP}/boot.env" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text("".join(line for line in path.read_text().splitlines(keepends=True)
                        if not line.startswith("BOOT_OWNER_EMAIL=")))
PY
if "${scripts}/server-up.sh" >"${work}/missing.out" 2>"${work}/missing.err"; then
  echo "server-up accepted kept state with no owner or working key" >&2
  exit 1
fi
[[ ! -s "${work}/missing.out" ]]
grep -q 'kept state has no owner or working key' "${work}/missing.err"
if curl -fsS --max-time 2 "${MARFA_TEST_URL}/health" >/dev/null 2>&1; then
  echo "server-up started a server before refusing incomplete kept state" >&2
  exit 1
fi
echo "Incomplete kept state is refused before starting a server."
