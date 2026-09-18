#!/usr/bin/env bash
# Boots the monorepo server on SQLite in a throwaway directory, mints the
# first key from the bootstrap secret the server prints, and writes an env
# file naming the server, a working key and the process to stop.
#
#   eval "$(scripts/server-up.sh)"      # exports MARFA_TEST_URL, MARFA_TEST_KEY, MARFA_SERVER_ENV
#   scripts/server-down.sh              # stops it and removes the directory
#
# MARFA_SERVER_REPO points at the monorepo checkout to boot; the default is
# the checkout this script lives in. PORT defaults to 8600.
set -euo pipefail

repo="${MARFA_SERVER_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
port="${PORT:-8600}"
url="http://127.0.0.1:${port}"
state="$(mktemp -d "${TMPDIR:-/tmp}/marfa-core-server.XXXXXX")"
log="${state}/server.log"

export DB_DIALECT=sqlite
export SQLITE_PATH="${state}/marfa.db"
export BLOB_PATH="${state}/blobs"
export PORT="${port}"
export MARFA_AUTH_SECRET="${MARFA_AUTH_SECRET:-$(openssl rand -hex 32)}"
export API_KEY_SALT="${API_KEY_SALT:-$(openssl rand -hex 32)}"

(
  cd "${repo}"
  exec pnpm --filter @withmarfa/server exec tsx --import ./src/instrumentation.ts src/index.ts
) >"${log}" 2>&1 &
pid=$!

fail() {
  echo "server-up: $1" >&2
  echo "server-up: log follows" >&2
  cat "${log}" >&2 || true
  kill "${pid}" 2>/dev/null || true
  exit 1
}

for _ in $(seq 1 120); do
  if curl -fsS "${url}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    fail "the server exited before answering /health"
  fi
  sleep 0.5
done
curl -fsS "${url}/health" >/dev/null 2>&1 || fail "no answer from ${url}/health"

secret=""
for _ in $(seq 1 40); do
  if [[ "$(cat "${log}")" =~ Bearer\ ([0-9a-f]{64}) ]]; then
    secret="${BASH_REMATCH[1]}"
    break
  fi
  sleep 0.5
done
[[ -n "${secret}" ]] || fail "no bootstrap secret in the server log"

mint() {
  curl -sS -X POST "${url}/keys" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -d "{\"label\":\"$2\",\"source\":\"$2\"}"
}

read_key() {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("key",""))'
}

# Bootstrap answers with the operator key, which holds no permissions because
# running the instance sits outside the permission model; the operator mints
# the key that works. Two source names, because the server refuses a second
# key under a source display name already in use.
bootstrap="$(mint "${secret}" core-proof-operator)"
operator="$(read_key <<<"${bootstrap}")"
[[ -n "${operator}" ]] || fail "bootstrap did not mint an operator key: ${bootstrap}"
working="$(mint "${operator}" core-proof)"
key="$(read_key <<<"${working}")"
[[ -n "${key}" ]] || fail "the operator key could not mint a working key: ${working}"

env_file="${state}/env"
{
  echo "export MARFA_TEST_URL='${url}'"
  echo "export MARFA_TEST_KEY='${key}'"
  echo "export MARFA_SERVER_ENV='${env_file}'"
  echo "export MARFA_SERVER_PID='${pid}'"
  echo "export MARFA_SERVER_STATE='${state}'"
} >"${env_file}"
cat "${env_file}"
