#!/usr/bin/env bash
# Boots the monorepo server on SQLite, mints the first key from the
# bootstrap secret the server prints, and writes an env file naming the
# server, a working key and the process to stop.
#
#   env_text="$(scripts/server-up.sh)" && eval "${env_text}"
#                                       # exports MARFA_TEST_URL, MARFA_TEST_KEY, MARFA_SERVER_ENV
#   scripts/server-down.sh              # stops it, and removes a directory it made
#
# Assigned and then evaluated, never `eval "$(…)"` alone: `eval` of an empty
# string succeeds, so a boot that failed would leave the caller running on
# whatever the last boot exported.
#
# Set MARFA_SERVER_ENV first to choose where the env file goes. A caller that
# wants to clean up after a boot that failed has to, because the default sits
# inside a throwaway directory whose name is only printed on success.
#
# MARFA_SERVER_REPO points at the monorepo checkout to boot; the default is
# the checkout this script lives in.
#
# MARFA_SERVER_KEEP names a directory to keep the instance in. The first
# boot there records its port, its secrets and the working key beside the
# database, and a later boot on the same directory reuses all four: the same
# origin, the same data, the same key. That is how a proof stops a server and
# brings it back. `server-down.sh` leaves that directory in place. It is an
# input only: the env file names the directory in MARFA_SERVER_STATE, which a
# second boot in the same shell does not read.
#
# PORT defaults to one the kernel says is free, because a fixed default
# cannot be right for both callers: the runner pool runs on a developer's own
# Mac, so a local boot and a CI job would take the same port and whichever
# arrived second would fail to bind against a process belonging to the other.
set -euo pipefail

repo="${MARFA_SERVER_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Asked of the kernel, then released so the server can bind it a moment
# later. The window between is not zero, which is why the health check below
# is what decides a boot succeeded rather than this line.
#
# Asked on the address the server binds, not the one the URL names. Node
# given no host listens on `::` with IPv6-only off where the machine has
# IPv6, which takes the port in both families, and on `0.0.0.0` where it does
# not. A port asked of `127.0.0.1` alone can be one a listener holds on IPv6,
# and the server's bind then fails with `EADDRINUSE`.
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
  state="$(mktemp -d "${TMPDIR:-/tmp}/marfa-core-server.XXXXXX")"
fi
boot="${state}/boot.env"
kept_key=""
if [[ -f "${boot}" ]]; then
  # shellcheck disable=SC1090
  source "${boot}"
  PORT="${BOOT_PORT}"
  MARFA_AUTH_SECRET="${BOOT_AUTH_SECRET}"
  API_KEY_SALT="${BOOT_KEY_SALT}"
  kept_key="${BOOT_KEY}"
fi
port="${PORT:-$(free_port)}"
url="http://127.0.0.1:${port}"
log="${state}/server.log"

export SQLITE_PATH="${state}/marfa.db"
export BLOB_PATH="${state}/blobs"
export PORT="${port}"
export MARFA_AUTH_SECRET="${MARFA_AUTH_SECRET:-$(openssl rand -hex 32)}"
export API_KEY_SALT="${API_KEY_SALT:-$(openssl rand -hex 32)}"

# Refused here rather than left to the server, which reports a port already
# in use as an unhandled `EADDRINUSE` and a node stack trace. On a shared
# runner the usual cause is a server a previous run failed to stop, and that
# is worth saying in one line.
if curl -fsS --max-time 2 "${url}/health" >/dev/null 2>&1; then
  echo "server-up: something is already answering ${url}/health" >&2
  echo "server-up: stop it, or set PORT to boot somewhere else" >&2
  exit 1
fi

# The subshell `exec`s into pnpm, which spawns tsx, which spawns node, so the
# pid recorded here is pnpm's and the process holding the port is two levels
# below it. `server-down.sh` walks down from this pid rather than signaling
# it alone.
#
# **A process group would be tidier and is not reliable here.** `set -m` gives
# a background job its own group only where the shell has job control, and
# this script is routinely run inside a command substitution, where it does
# not: the job then shares the script's group, `kill -- -$pid` names a group
# that is not the server's, and the fallback kills pnpm and orphans node.
(
  cd "${repo}"
  exec pnpm --filter @withmarfa/server exec tsx --import ./src/instrumentation.ts src/index.ts
) >"${log}" 2>&1 &
pid=$!

# The caller may name the env file, and a caller that has to clean up after a
# failed boot must: the path is otherwise inside a `mktemp` directory this
# script alone knows, so a boot that dies before printing it leaves a running
# server nobody can address.
env_file="${MARFA_SERVER_ENV:-${state}/env}"

# **Written before the server is known to be up, not after.** Everything
# below can fail, and a caller that cannot read the pid cannot stop what this
# script started: `server-down.sh` answers "no env file" and the server runs
# on. The key is filled in once there is one; the two lines that matter for
# cleanup are here from the start.
write_env() {
  {
    echo "export MARFA_TEST_URL='${url}'"
    echo "export MARFA_TEST_KEY='${1:-}'"
    echo "export MARFA_SERVER_ENV='${env_file}'"
    echo "export MARFA_SERVER_PID='${pid}'"
    echo "export MARFA_SERVER_STATE='${state}'"
    echo "export MARFA_SERVER_KEPT='${keep}'"
  } >"${env_file}"
}
write_env ""

fail() {
  echo "server-up: $1" >&2
  echo "server-up: log follows" >&2
  cat "${log}" >&2 || true
  "$(dirname "$0")/server-down.sh" "${env_file}" >/dev/null 2>&1 || true
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

if [[ -n "${kept_key}" ]]; then
  write_env "${kept_key}"
  cat "${env_file}"
  exit 0
fi

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
# key naming as its own a source another key already holds.
bootstrap="$(mint "${secret}" core-proof-operator)"
operator="$(read_key <<<"${bootstrap}")"
[[ -n "${operator}" ]] || fail "bootstrap did not mint an operator key: ${bootstrap}"
working="$(mint "${operator}" core-proof)"
key="$(read_key <<<"${working}")"
[[ -n "${key}" ]] || fail "the operator key could not mint a working key: ${working}"

write_env "${key}"
if [[ -n "${keep}" ]]; then
  {
    echo "BOOT_PORT='${port}'"
    echo "BOOT_AUTH_SECRET='${MARFA_AUTH_SECRET}'"
    echo "BOOT_KEY_SALT='${API_KEY_SALT}'"
    echo "BOOT_KEY='${key}'"
  } >"${boot}"
fi
cat "${env_file}"
