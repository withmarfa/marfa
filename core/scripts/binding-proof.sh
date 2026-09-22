#!/usr/bin/env bash
# Drives both bindings through a write made offline and its verdict after the
# server comes back: each proof hydrates, the server stops, each queues its
# writes and drains into nothing, the server returns on the same origin with
# the same data, and each drains again.
#
#   scripts/binding-proof.sh            # after build.sh and the Node build
set -euo pipefail

core="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-binding-proof.XXXXXX")"
export MARFA_SERVER_STATE="${work}/server"
export MARFA_SERVER_ENV="${work}/server.env"
trap '"${core}/scripts/server-down.sh" "${MARFA_SERVER_ENV}" >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

swift_proof() { (cd "${core}/bindings/swift/Example" && MARFA_DB="${work}/swift.sqlite" swift run --quiet marfa-core-example "$1"); }
node_proof() { (cd "${core}/bindings/node" && MARFA_DB="${work}/node.sqlite" node scripts/proof.mjs "$1"); }

up() {
  eval "$("${core}/scripts/server-up.sh")"
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
