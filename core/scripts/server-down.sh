#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-${MARFA_SERVER_ENV:-}}"
[[ -n "${env_file}" && -f "${env_file}" ]] || { echo "server-down: no env file" >&2; exit 2; }
# shellcheck disable=SC1090
source "${env_file}"
# The recorded pid is pnpm's; the node process holding the port is its
# grandchild, so the whole tree is signaled. Not by process group: inside a
# command substitution the job shares the caller's group. Children are
# collected before any is signaled, since an orphan can no longer be found.
descendants() {
  local parent="$1" child
  for child in $(pgrep -P "${parent}" 2>/dev/null); do
    descendants "${child}"
    echo "${child}"
  done
}

stop() {
  local signal="$1" pid
  for pid in $(descendants "${MARFA_SERVER_PID}") "${MARFA_SERVER_PID}"; do
    kill -"${signal}" "${pid}" 2>/dev/null || true
  done
}

if kill -0 "${MARFA_SERVER_PID}" 2>/dev/null; then
  stop TERM
  for _ in $(seq 1 40); do
    kill -0 "${MARFA_SERVER_PID}" 2>/dev/null || break
    sleep 0.25
  done
  stop KILL
fi
[[ -z "${MARFA_SERVER_CONTROL_DIR:-}" ]] || rm -rf "${MARFA_SERVER_CONTROL_DIR}"
[[ -n "${MARFA_SERVER_KEPT:-}" ]] || rm -rf "${MARFA_SERVER_STATE}"
# A stale env file names a pid the system may since have reused.
[[ "${env_file}" == "${MARFA_SERVER_STATE}"/* ]] || rm -f "${env_file}"
