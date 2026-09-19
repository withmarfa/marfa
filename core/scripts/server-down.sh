#!/usr/bin/env bash
# Stops the server server-up.sh started and removes its directory.
set -euo pipefail

env_file="${1:-${MARFA_SERVER_ENV:-}}"
[[ -n "${env_file}" && -f "${env_file}" ]] || { echo "server-down: no env file" >&2; exit 2; }
# shellcheck disable=SC1090
source "${env_file}"
# **The tree, not the pid, and not the process group.** `server-up.sh` records
# pnpm's pid; pnpm spawns tsx and tsx spawns the node process that holds the
# port, so signaling the recorded pid alone leaves that grandchild running
# and the port bound — while reporting success, which is the worst shape of
# this bug: the next reader sees that cleanup ran and looks elsewhere.
#
# A process group would take the tree in one signal, and `set -m` does not
# reliably give the job one: inside a command substitution the shell has no
# job control and the job shares the caller's group, so the group signal
# either misses or, worse, names a group with the caller in it.
#
# Walking `pgrep -P` is slower and has no such failure. Children are
# collected before anything is signalled, because a parent that dies first
# reparents its children to init and they can no longer be found this way.
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
rm -rf "${MARFA_SERVER_STATE}"
# The env file too, when the caller placed it outside the state directory. A
# stale one names a pid that is gone, and the next run to read it would signal
# whatever the system has since given that number to.
[[ "${env_file}" == "${MARFA_SERVER_STATE}"/* ]] || rm -f "${env_file}"
