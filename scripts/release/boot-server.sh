#!/usr/bin/env bash
# Boots a `marfa-server` on throwaway state, waits for `/health`, and requires a clean stop.
#
#   boot-server.sh <marfa-server>
set -euo pipefail

server="$1"
if [ ! -x "$server" ]; then
  echo "::error::$server is not an executable file."
  exit 1
fi

state=$(mktemp -d /tmp/marfa-boot.XXXXXX)
pid=
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -rf "$state"
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  echo "--- the server's log"
  tail -40 "$state/log" || true
  exit 1
}

(
  cd "$state"
  exec env -i HOME="$state" PATH="$PATH" MARFA_PORT=0 MARFA_LISTEN_HOST=127.0.0.1 \
    MARFA_KEY_SALT="$(openssl rand -hex 32)" MARFA_AUTH_SECRET="$(openssl rand -hex 32)" \
    "$server"
) >"$state/log" 2>&1 &
pid=$!

port=
for _ in $(seq 1 120); do
  port=$(awk '/Marfa server listening on port [0-9]+/ { match($0, /port [0-9]+/); print substr($0, RSTART + 5, RLENGTH - 5); exit }' "$state/log")
  [ -n "$port" ] && break
  kill -0 "$pid" 2>/dev/null || fail "$(basename "$server") ended before it listened."
  sleep 0.5
done
[ -n "$port" ] || fail "$(basename "$server") did not listen within a minute."

status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/health") ||
  fail "/health could not be reached on port $port."
[ "$status" = 200 ] || fail "/health answered $status, not 200."
echo "$(basename "$server") booted and /health answered 200"

kill -TERM "$pid"
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then fail "$(basename "$server") did not stop within ten seconds of SIGTERM."; fi
code=0
wait "$pid" || code=$?
pid=
[ "$code" = 0 ] || fail "$(basename "$server") stopped with status $code, not 0."
echo "$(basename "$server") stopped with status 0"
