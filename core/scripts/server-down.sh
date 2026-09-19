#!/usr/bin/env bash
# Stops the server server-up.sh started and removes its directory.
set -euo pipefail

env_file="${1:-${MARFA_SERVER_ENV:-}}"
[[ -n "${env_file}" && -f "${env_file}" ]] || { echo "server-down: no env file" >&2; exit 2; }
# shellcheck disable=SC1090
source "${env_file}"
# The process group, not the pid. `server-up.sh` starts the server in a group
# of its own because the pid it records is pnpm's, and the node process that
# holds the port is pnpm's grandchild: signalling the pid alone leaves that
# grandchild running and the port bound. The plain pid is the fallback for a
# group that has already gone.
stop() {
  kill -"$1" -- -"${MARFA_SERVER_PID}" 2>/dev/null ||
    kill -"$1" "${MARFA_SERVER_PID}" 2>/dev/null || true
}

if kill -0 "${MARFA_SERVER_PID}" 2>/dev/null; then
  stop TERM
  for _ in $(seq 1 40); do
    kill -0 "${MARFA_SERVER_PID}" 2>/dev/null || break
    sleep 0.25
  done
  stop KILL
fi
rm -rf "${MARFA_SERVER_STATE}"
# The env file too, when the caller placed it outside the state directory. A
# stale one names a pid that is gone, and the next run to read it would signal
# whatever the system has since given that number to.
[[ "${env_file}" == "${MARFA_SERVER_STATE}"/* ]] || rm -f "${env_file}"
