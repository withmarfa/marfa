#!/usr/bin/env bash
# Boots a built server image through its entrypoint and holds it to what the
# deploy guide says it does. Usage: scripts/check-image.sh <image> <sha>.
#
# The image is built from `deploy/Dockerfile` with `VERSION_SHA=<sha>` by the
# caller. Three runs, none with a bucket, so none needs an object store:
#
# 1. a fresh volume: the container becomes healthy, the root document reports
#    the commit the image was built from, and `docker stop` ends it with
#    status 0 inside the grace a runtime gives it;
# 2. a volume holding a database another build wrote: the container stays up
#    and unhealthy with the server's message in its log, rather than ending
#    and being started again, and `docker stop` still ends it with status 0.
set -euo pipefail
# Under pipefail, `producer | grep -q` fails when grep matches and exits before
# the producer has written everything, so a match is read from a here-string.

image=${1:?usage: check-image.sh <image> <sha>}
sha=${2:?usage: check-image.sh <image> <sha>}
work=$(mktemp -d)
containers=()

cleanup() {
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  for name in "${containers[@]}"; do
    echo "--- log of $name"
    docker logs "$name" 2>&1 | tail -40 || true
  done
  exit 1
}

# The image's own health command, run on a shorter schedule so the check does
# not wait out the minutes a deployment's cadence allows for.
health=(--health-interval 5s --health-timeout 3s --health-retries 2 --health-start-period 1s)

# `openssl rand -hex 32` is what the deploy guide tells an owner to use.
secrets=(
  -e "API_KEY_SALT=$(openssl rand -hex 32)"
  -e "MARFA_AUTH_SECRET=$(openssl rand -hex 32)"
  -e "MARFA_AUTH_BASE_URL=http://localhost:8600"
)

port_of() { docker port "$1" 8600/tcp | sed -n '1s/.*://p'; }

until_true() {
  local what=$1 seconds=$2
  shift 2
  local deadline=$((SECONDS + seconds))
  until "$@"; do
    if ((SECONDS > deadline)); then fail "$what did not happen within ${seconds}s"; fi
    sleep 1
  done
}

stop_and_check() {
  local name=$1 started ended code
  started=$(date +%s%N)
  docker stop --time 10 "$name" >/dev/null
  ended=$(date +%s%N)
  code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
  [ "$code" = 0 ] || fail "$name stopped with status $code, not 0"
  local ms=$(((ended - started) / 1000000))
  [ "$ms" -lt 8000 ] || fail "$name took ${ms}ms to stop, past the 8000ms the deploy guide promises"
  echo "$name stopped with status 0 in ${ms}ms"
}

echo "== a fresh volume"
fresh=marfa-check-fresh-$$
containers+=("$fresh")
docker run -d --name "$fresh" -p 127.0.0.1::8600 "${health[@]}" "${secrets[@]}" "$image" >/dev/null
port=$(port_of "$fresh")
healthy() { curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; }
until_true "the container answering /health" 90 healthy
body=$(curl -fsS "http://127.0.0.1:$port/")
grep -q "\"version\":\"$sha\"" <<<"$body" || fail "the root document does not report $sha: $body"
until_true "the image's own health check passing" 60 \
  bash -c "[ \"\$(docker inspect --format '{{.State.Health.Status}}' $fresh)\" = healthy ]"
echo "booted, reports $sha, healthy"
# Exercise the actual packaged command and the production claim/recovery services.
docker exec -i "$fresh" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const cli = (args, body) => {
  const result = spawnSync('marfa', ['--socket', '/data/control/marfa.sock', '--json', ...args], {encoding:'utf8', input: body && JSON.stringify(body)});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
assert.equal(cli(['setup','status']).claimed, false);
const email='owner@example.com';
const oldPassword='initial-container-password';
const newPassword='replacement-container-password';
cli(['setup','claim','--stdin'], {email,password:oldPassword});
assert.equal(cli(['setup','status']).claimed,true);
const key = cli(['keys','create','--label','container-check','--source','container-check','--permission','instance.read','--no-claims']);
assert.ok(key.key);
const signIn = password => fetch('http://localhost:8600/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json','Origin':'http://localhost:8600'},body:JSON.stringify({email,password})});
assert.equal((await signIn(oldPassword)).status,200);
cli(['owner','recover','--stdin'],{password:newPassword});
assert.notEqual((await signIn(oldPassword)).status,200);
assert.equal((await signIn(newPassword)).status,200);
const ordinary=await fetch('http://localhost:8600/keys/current',{headers:{Authorization:`Bearer ${key.key}`}});
assert.equal(ordinary.status,200);
const forged=await fetch('http://localhost:8600/_control/owner/recover',{method:'POST',headers:{'Content-Type':'application/json','X-Marfa-Local-Authority':'true'},body:JSON.stringify({password:'forged-container-password'})});
assert.notEqual(forged.status,200);
assert.equal((await signIn(newPassword)).status,200);
console.log('Packaged CLI claimed and recovered the owner; ordinary key still works; public authority forgery refused.');
JS

stop_and_check "$fresh"

echo "== a volume holding a database another build wrote"
refused=marfa-check-refused-$$
containers+=("$refused")
mkdir -p "$work/data"
# The retired registry table is one this build will not read, which refuses the
# file without the check needing a second build.
sqlite3 "$work/data/marfa.db" "CREATE TABLE custom_types (id TEXT);"
chmod -R a+rwX "$work/data"
docker run -d --name "$refused" -v "$work/data:/data" "${health[@]}" "${secrets[@]}" "$image" >/dev/null
logged() { grep -q "stays up, unhealthy" <<<"$(docker logs "$refused" 2>&1)"; }
until_true "the container saying why it will not start" 90 logged
grep -q "export it with the build that wrote it" <<<"$(docker logs "$refused" 2>&1)" \
  || fail "the log does not name the way forward"
sleep 5
[ "$(docker inspect --format '{{.State.Running}}' "$refused")" = true ] \
  || fail "the container ended instead of staying up"
[ "$(docker inspect --format '{{.RestartCount}}' "$refused")" = 0 ] \
  || fail "the container was restarted"
until_true "the image's own health check failing" 60 \
  bash -c "[ \"\$(docker inspect --format '{{.State.Health.Status}}' $refused)\" = unhealthy ]"
echo "stayed up, unhealthy, with the message in its log"
stop_and_check "$refused"

echo "the image holds to what the deploy guide says"
