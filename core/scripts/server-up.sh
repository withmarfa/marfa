#!/usr/bin/env bash
# Boots the monorepo server on SQLite in a throwaway directory, mints the
# first key from the bootstrap secret the server prints, and writes an env
# file naming the server, a working key and the process to stop.
#
#   eval "$(scripts/server-up.sh)"      # exports MARFA_TEST_URL, MARFA_TEST_KEY, MARFA_SERVER_ENV
#   scripts/server-down.sh              # stops it and removes the directory
#
# Set MARFA_SERVER_ENV first to choose where the env file goes. A caller that
# wants to clean up after a boot that failed has to, because the default sits
# inside a throwaway directory whose name is only printed on success.
#
# MARFA_SERVER_REPO points at the monorepo checkout to boot; the default is
# the checkout this script lives in.
#
# PORT defaults to one the kernel says is free. **It used to be 8600**, and
# the runner pool runs on a developer's own Mac: a local boot and a CI job
# took the same port, and whichever arrived second failed to bind against a
# process belonging to the other. A fixed default cannot be right for both.
set -euo pipefail

repo="${MARFA_SERVER_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Asked of the kernel, then released so the server can bind it a moment
# later. The window between is not zero, which is why the health check below
# is what decides a boot succeeded rather than this line.
free_port() {
  python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()'
}
port="${PORT:-$(free_port)}"
url="http://127.0.0.1:${port}"
state="$(mktemp -d "${TMPDIR:-/tmp}/marfa-core-server.XXXXXX")"
log="${state}/server.log"

export DB_DIALECT=sqlite
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
# below it. `server-down.sh` walks down from this pid rather than signalling
# it alone.
#
# **A process group would be tidier and is not reliable here.** `set -m` gives
# a background job its own group only where the shell has job control, and
# this script is routinely run inside a command substitution, where it does
# not: the job then shares the script's group, `kill -- -$pid` names a group
# that is not the server's, and the fallback kills pnpm and orphans node.
# Measured after that shape had already shipped.
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

write_env "${key}"
cat "${env_file}"
