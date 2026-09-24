#!/usr/bin/env bash
# Drives both bindings through a write made offline and its verdict after the
# server comes back: each proof hydrates, the server stops, each queues its
# writes and drains into nothing, the server returns on the same origin with
# the same data, and each drains again. Then each holds the event stream open
# while the binary makes a note on the server, and is told of it.
#
# Each proof checks what it printed and exits non-zero on anything else, so
# this script fails when a verdict does.
#
#   scripts/binding-proof.sh            # after build.sh, the Node build and cargo build -p marfa-cli
set -euo pipefail

core="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-binding-proof.XXXXXX")"
export MARFA_SERVER_KEEP="${work}/server"
export MARFA_SERVER_ENV="${work}/server.env"
trap '"${core}/scripts/server-down.sh" "${MARFA_SERVER_ENV}" >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

swift_proof() { (cd "${core}/bindings/swift/Example" && MARFA_DB="${work}/swift.sqlite" swift run --quiet marfa-core-example "$1"); }
node_proof() { (cd "${core}/bindings/node" && MARFA_DB="${work}/node.sqlite" node scripts/proof.mjs "$1"); }

up() {
  local env_text
  env_text="$("${core}/scripts/server-up.sh")"
  eval "${env_text}"
  export MARFA_API_URL="${MARFA_TEST_URL}" MARFA_API_KEY="${MARFA_TEST_KEY}"
}

up
echo "== hydrate, server up at ${MARFA_API_URL}"
swift_proof hydrate
node_proof hydrate

"${core}/scripts/server-down.sh" "${MARFA_SERVER_ENV}"
echo "== write, server stopped"
swift_proof write
node_proof write

up
echo "== drain, server back at ${MARFA_API_URL}"
swift_proof drain
node_proof drain

echo "== follow, while the binary makes a note on the server"
swift_proof follow &
swift_follow=$!
node_proof follow &
node_follow=$!
sleep 3
"${core}/target/debug/marfa" --url "${MARFA_API_URL}" --key "${MARFA_API_KEY}" \
  items create --type core.note --tier feed \
  --properties '{"title":"Made by the binary","body":"arrives through follow"}' >/dev/null
wait "${swift_follow}"
wait "${node_follow}"
