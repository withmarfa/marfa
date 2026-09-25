#!/usr/bin/env bash
# Drives the Node binding through a write made offline and its verdict after
# the server comes back: the proof hydrates, the server stops, it queues its
# writes and drains into nothing, the server returns on the same origin with
# the same data, and it drains again. Then it holds the event stream open
# while the binary makes a note on the server, and is told of it. Last, it
# reads the thumbnails of a type the binary registers, from a store of its own.
#
# The proof checks what it printed and exits non-zero on anything else, so
# this script fails when a verdict does.
#
#   scripts/binding-proof.sh            # after the Node build and cargo build -p marfa-cli
set -euo pipefail

core="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/marfa-binding-proof.XXXXXX")"
export MARFA_SERVER_KEEP="${work}/server"
export MARFA_SERVER_ENV="${work}/server.env"
trap '"${core}/scripts/server-down.sh" "${MARFA_SERVER_ENV}" >/dev/null 2>&1 || true; rm -rf "${work}"' EXIT

node_proof() { (cd "${core}/bindings/node" && MARFA_DB="${work}/node.sqlite" node scripts/proof.mjs "$1"); }

up() {
  local env_text
  env_text="$("${core}/scripts/server-up.sh")"
  eval "${env_text}"
  export MARFA_API_URL="${MARFA_TEST_URL}" MARFA_API_KEY="${MARFA_TEST_KEY}"
}

up
echo "== hydrate, server up at ${MARFA_API_URL}"
node_proof hydrate

"${core}/scripts/server-down.sh" "${MARFA_SERVER_ENV}"
echo "== write, server stopped"
node_proof write

up
echo "== drain, server back at ${MARFA_API_URL}"
node_proof drain

echo "== follow, while the binary makes a note on the server"
node_proof follow &
node_follow=$!
sleep 3
"${core}/target/debug/marfa" --url "${MARFA_API_URL}" --key "${MARFA_API_KEY}" \
  items create --type core.note --tier feed \
  --properties '{"title":"Made by the binary","body":"arrives through follow"}' >/dev/null
wait "${node_follow}"

echo "== thumbnail, read from the copy with no request"
marfa() { "${core}/target/debug/marfa" --url "${MARFA_API_URL}" --key "${MARFA_API_KEY}" "$@" >/dev/null; }
# One item holds a value under the property before the type declares it a
# thumbnail, which the server does not check again once it does, so the copy
# holds an image and a value that is not one.
marfa types register --body '{"id":"user.snapshot","fields":{"title":{"type":"string"}}}'
marfa items create --type user.snapshot \
  --properties '{"title":"Held before","thumbnail":"not an image"}'
marfa types update user.snapshot \
  --body '{"version":2,"fields":{"title":{"type":"string"},"thumbnail":{"type":"thumbnail"}}}'
# A PNG's signature, then the words the proof looks for.
marfa items create --type user.snapshot \
  --properties '{"title":"With an image","thumbnail":"data:image/png;base64,iVBORw0KGgpiaW5kaW5nIHByb29m"}'
node_proof thumbnail
