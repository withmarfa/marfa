#!/usr/bin/env bash
#   env_text="$(scripts/server-up.sh)" && eval "${env_text}"
#                                       # exports URL, working key and control socket, the test owner and MARFA_SERVER_ENV
#   scripts/server-down.sh              # stops it, and removes a directory it made
#
# Assign, then eval: `eval "$(…)"` of a failed boot's empty output succeeds.
#
# MARFA_SERVER_ENV: where the env file goes. Set it to clean up after a failed
# boot, since the default directory's name is printed only on success.
# MARFA_SERVER_REPO: the checkout to boot; this one by default.
# MARFA_SERVER_KEEP: a directory a later boot reuses, with the same port,
# secrets, data and keys; server-down.sh leaves it in place.
# PORT: a free one by default.
#
# A boot also creates an owner, so sign-in and the owner's pages can be tried
# by hand. Its throwaway email and password come from test-owner.example.env
# and are printed as MARFA_TEST_OWNER_EMAIL and MARFA_TEST_OWNER_PASSWORD.
set -euo pipefail
umask 077

repo="${MARFA_SERVER_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Asked on the address the server binds (`::` dual-stack, else `0.0.0.0`),
# not the URL's: a port free on `127.0.0.1` alone can be held on IPv6.
free_port() {
  python3 -c 'import socket
try:
    s = socket.socket(socket.AF_INET6)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.bind(("::", 0))
except OSError:
    s = socket.socket()
    s.bind(("0.0.0.0", 0))
print(s.getsockname()[1])
s.close()'
}
keep=""
if [[ -n "${MARFA_SERVER_KEEP:-}" ]]; then
  state="${MARFA_SERVER_KEEP}"
  keep=1
  mkdir -p "${state}"
else
  state="$(mktemp -d "/tmp/marfa-core-server.XXXXXX")"
fi
state="$(cd "${state}" && pwd -P)"
boot="${state}/boot.env"
kept_key=""
owner_email=""
owner_password=""
if [[ -f "${boot}" ]]; then
  chmod 600 "${boot}"
  # shellcheck disable=SC1090
  source "${boot}"
  PORT="${BOOT_PORT}"
  MARFA_AUTH_SECRET="${BOOT_AUTH_SECRET}"
  API_KEY_SALT="${BOOT_KEY_SALT}"
  kept_key="${BOOT_KEY}"
  owner_email="${BOOT_OWNER_EMAIL:-}"
  owner_password="${BOOT_OWNER_PASSWORD:-}"
  if [[ -z "${owner_email}" || -z "${owner_password}" || -z "${kept_key}" ]]; then
    echo "server-up: kept state has no owner or working key; use a fresh MARFA_SERVER_KEEP directory" >&2
    exit 1
  fi
fi
port="${PORT:-$(free_port)}"
url="http://127.0.0.1:${port}"
log="${state}/server.log"

export SQLITE_PATH="${state}/marfa.db"
export BLOB_PATH="${state}/blobs"
export PORT="${port}"
export MARFA_AUTH_SECRET="${MARFA_AUTH_SECRET:-$(openssl rand -hex 32)}"
export API_KEY_SALT="${API_KEY_SALT:-$(openssl rand -hex 32)}"

# A silent listener on `127.0.0.1` would still let the server bind `::`, and
# every health check would reach the silent one; curl exits 28 for it.
probe=0
curl -fsS --max-time 2 "${url}/health" >/dev/null 2>&1 || probe=$?
if [[ "${probe}" -eq 0 ]]; then
  echo "server-up: something is already answering ${url}/health" >&2
  echo "server-up: stop it, or set PORT to boot somewhere else" >&2
  exit 1
fi
if [[ "${probe}" -eq 28 ]]; then
  echo "server-up: something at ${url} takes connections and does not answer" >&2
  echo "server-up: stop it, or set PORT to boot somewhere else" >&2
  exit 1
fi

# A kept data directory can exceed the Unix socket path limit, especially
# under macOS temporary roots. The private listener gets its own short path.
control_dir="$(mktemp -d "/tmp/marfa-core-control.XXXXXX")"
control_dir="$(cd "${control_dir}" && pwd -P)"
export MARFA_CONTROL_SOCKET="${control_dir}/marfa.sock"

# The pid is pnpm's, two levels above node; server-down.sh walks the tree.
(
  cd "${repo}"
  exec pnpm --filter @withmarfa/server exec tsx --import ./src/instrumentation.ts src/index.ts
) >"${log}" 2>&1 &
pid=$!

env_file="${MARFA_SERVER_ENV:-${state}/env}"

# Written before the server is up, so a failed boot can still be stopped.
write_env() {
  touch "${env_file}"
  chmod 600 "${env_file}"
  {
    echo "export MARFA_TEST_URL='${url}'"
    echo "export MARFA_TEST_KEY='${1:-}'"
    echo "export MARFA_TEST_SOCKET='${MARFA_CONTROL_SOCKET}'"
    if [[ -n "${owner_email}" ]]; then
      echo "export MARFA_TEST_OWNER_EMAIL='${owner_email}'"
      echo "export MARFA_TEST_OWNER_PASSWORD='${owner_password}'"
    fi
    echo "export MARFA_SERVER_ENV='${env_file}'"
    echo "export MARFA_SERVER_PID='${pid}'"
    echo "export MARFA_SERVER_STATE='${state}'"
    echo "export MARFA_SERVER_CONTROL_DIR='${control_dir}'"
    echo "export MARFA_SERVER_KEPT='${keep}'"
  } >"${env_file}"
}
write_env ""

fail() {
  echo "server-up: $1" >&2
  echo "server-up: log follows" >&2
  # Setup proof belongs only to this process's private log.
  sed -E 's/setup code: [A-Z2-7-]+/setup code: [redacted]/g' "${log}" >&2 || true
  "$(dirname "$0")/server-down.sh" "${env_file}" >/dev/null 2>&1 || true
  exit 1
}

for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "${url}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    fail "the server exited before answering /health"
  fi
  sleep 0.5
done
curl -fsS --max-time 2 "${url}/health" >/dev/null 2>&1 || fail "no answer from ${url}/health"

if [[ -n "${kept_key}" ]]; then
  write_env "${kept_key}"
  cat "${env_file}"
  exit 0
fi

# Provision through the production private authority, with secrets on stdin.
# shellcheck disable=SC1091
source "$(dirname "$0")/test-owner.example.env"
export MARFA_TEST_OWNER_EMAIL MARFA_TEST_OWNER_PASSWORD
created="$(python3 -c 'import json,os; print(json.dumps({"email":os.environ["MARFA_TEST_OWNER_EMAIL"],"password":os.environ["MARFA_TEST_OWNER_PASSWORD"]}))' |
  curl -fsS --max-time 15 --unix-socket "${MARFA_CONTROL_SOCKET}" \
    -X POST http://localhost/_control/setup/claim -H 'Content-Type: application/json' --data-binary @-)" || fail "the owner claim failed"
[[ "${created}" == *'"email"'* ]] || fail "the claim returned no owner"
owner_email="${MARFA_TEST_OWNER_EMAIL}"
owner_password="${MARFA_TEST_OWNER_PASSWORD}"
working="$(curl -fsS --max-time 15 --unix-socket "${MARFA_CONTROL_SOCKET}" \
  -X POST http://localhost/keys -H 'Content-Type: application/json' --data-binary @- <<'JSON'
{"label":"core-proof","source":"core-proof","permissions":["schema.write","keys.mint","items.purge","webhooks.manage","config.manage","audit.read","grants.manage","instance.read","instance.maintain","connectors.manage","blobs.manage","keys.manage"],"type_permissions":{"*":"write"},"extension_permissions":{"*":"write"},"edge_permissions":{"*":"write"},"metadata_permissions":{"*":"write"},"profile_permissions":{"*":"read"}}
JSON
)" || fail "the local authority could not mint a working key"
key="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("key",""))' <<<"${working}")"
[[ -n "${key}" ]] || fail "the mint returned no working key"

write_env "${key}"
if [[ -n "${keep}" ]]; then
  {
    echo "BOOT_PORT='${port}'"
    echo "BOOT_AUTH_SECRET='${MARFA_AUTH_SECRET}'"
    echo "BOOT_KEY_SALT='${API_KEY_SALT}'"
    echo "BOOT_KEY='${key}'"
    echo "BOOT_OWNER_EMAIL='${owner_email}'"
    echo "BOOT_OWNER_PASSWORD='${owner_password}'"
  } >"${boot}"
fi
cat "${env_file}"
