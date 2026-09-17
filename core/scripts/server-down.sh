#!/usr/bin/env bash
# Stops the server server-up.sh started and removes its directory.
set -euo pipefail

env_file="${1:-${MARFA_SERVER_ENV:-}}"
[[ -n "${env_file}" && -f "${env_file}" ]] || { echo "server-down: no env file" >&2; exit 2; }
# shellcheck disable=SC1090
source "${env_file}"
if kill -0 "${MARFA_SERVER_PID}" 2>/dev/null; then
  kill "${MARFA_SERVER_PID}"
  for _ in $(seq 1 40); do
    kill -0 "${MARFA_SERVER_PID}" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "${MARFA_SERVER_PID}" 2>/dev/null || true
fi
rm -rf "${MARFA_SERVER_STATE}"
