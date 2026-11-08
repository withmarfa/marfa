#!/usr/bin/env bash
# Boots a built server image and holds it to what an owner is told it does.
# Usage: scripts/check-image.sh <image> <version>
#
# The image is built from `deploy/Dockerfile`. It is run on a fresh volume with a
# read-only root file system, so every write the server makes must land in /data:
#
# 1. it becomes healthy by its own health check and by `GET /health` from outside;
# 2. `GET /` reports <version>, the labels and both programs report it, and
#    the process is not root;
# 3. what it generated for itself is on the volume, private to its user;
# 4. `docker stop` ends it with status 0 inside the ten seconds a runtime allows;
# 5. started again on the same volume it is the same instance;
# 6. on a database a newer build wrote, it stays up and idle under a restart
#    policy, says why, and is never restarted.
set -euo pipefail

image=${1:?usage: check-image.sh <image> <version>}
version=${2:?usage: check-image.sh <image> <version>}
containers=()
volume=marfa-check-data-$(openssl rand -hex 8)
BUSYBOX=busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec

cleanup() {
  local name
  for name in ${containers[@]+"${containers[@]}"}; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  local name
  for name in ${containers[@]+"${containers[@]}"}; do
    echo "--- log of $name"
    docker logs "$name" 2>&1 | tail -40 || true
  done
  exit 1
}

until_true() {
  local what=$1 seconds=$2
  shift 2
  local deadline=$((SECONDS + seconds))
  until "$@"; do
    if ((SECONDS > deadline)); then fail "$what did not happen within ${seconds}s"; fi
    sleep 1
  done
}

# The image's own health check, on a shorter schedule than a deployment's.
health=(--health-interval 3s --health-timeout 3s --health-retries 3 --health-start-period 1s)
health_status() { docker inspect --format '{{.State.Health.Status}}' "$1"; }
becomes_healthy() { [ "$(health_status "$1")" = healthy ]; }

start() {
  local name=$1
  containers+=("$name")
  docker run -d --name "$name" --read-only --mount "type=volume,source=$volume,target=/data" \
    -p 127.0.0.1::8600 "${health[@]}" "$image" >/dev/null
}

port_of() { docker port "$1" 8600/tcp | sed -n '1s/.*://p'; }

# Under pipefail, `producer | grep -q` fails when grep matches and exits before the
# producer has written everything, so a match is read from a here-string.
stop_and_check() {
  local name=$1 code
  local started=$SECONDS
  docker stop --time 10 "$name" >/dev/null
  code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
  [ "$code" = 0 ] || fail "$name stopped with status $code, not 0 (137 means it was killed after ten seconds)"
  echo "$name stopped with status 0 in $((SECONDS - started))s"
}

echo "== what the image says it is"
user=$(docker inspect --format '{{.Config.User}}' "$image")
case "$user" in
  "" | 0 | root | 0:* | root:*) fail "the image runs as '${user:-root}', not as a user that is not root" ;;
esac
[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version" ] \
  || fail "the image's version label is not $version"
[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.title"}}' "$image")" != "" ] \
  || fail "the image has no title label"
reported=$(docker run --rm --entrypoint /usr/local/bin/marfa-server "$image" --version)
[ "$reported" = "marfa-server $version" ] || fail "the server reports '$reported', not 'marfa-server $version'"
reported=$(docker run --rm --entrypoint /usr/local/bin/marfa "$image" --version)
[ "$reported" = "marfa $version" ] || fail "the packaged command line reports '$reported', not 'marfa $version'"

echo "== a fresh volume"
fresh=marfa-check-fresh-$$
docker volume create "$volume" >/dev/null
start "$fresh"
until_true "the image's own health check passing" 90 becomes_healthy "$fresh"
port=$(port_of "$fresh")
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" = 200 ] \
  || fail "GET /health from outside the container did not answer 200"
body=$(curl -fsS "http://127.0.0.1:$port/")
grep -q "\"version\":\"$version\"" <<<"$body" || fail "the root document does not report $version: $body"
instance=$(sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p' <<<"$body")
[ -n "$instance" ] || fail "the root document names no instance: $body"
echo "booted, healthy, reports $version, instance $instance"

# `docker top` needs the pid column; `user` is understood by every `ps` an engine uses, `uid` is not.
uid=$(docker top "$fresh" -eo pid,user | awk 'NR == 2 { print $2 }')
case "$uid" in
  "" | 0 | root) fail "the server runs as '${uid:-unknown}'" ;;
esac
echo "runs as $uid with a read-only root file system"

# What it generated for itself is on the volume, readable by its user alone.
secrets=$(docker cp "$fresh:/data/marfa.secrets" - | tar -tv 2>/dev/null) || fail "no /data/marfa.secrets on the volume"
grep -q '^-rw-------' <<<"$secrets" || fail "the secrets file is not private to its user: $secrets"
docker cp "$fresh:/data/marfa.db" - >/dev/null 2>&1 || fail "no /data/marfa.db on the volume"
stop_and_check "$fresh"

echo "== the same volume again"
again=marfa-check-again-$$
start "$again"
until_true "the image's own health check passing" 90 becomes_healthy "$again"
port=$(port_of "$again")
body=$(curl -fsS "http://127.0.0.1:$port/")
grep -q "\"instance_id\":\"$instance\"" <<<"$body" || fail "a restart on the volume is another instance: $body"
stop_and_check "$again"

echo "== a database a newer build wrote"
# SQLite keeps user_version at byte 60 of the file, big-endian.
docker pull -q "$BUSYBOX" >/dev/null
docker run --rm --user 65532:65532 --mount "type=volume,source=$volume,target=/data" "$BUSYBOX" \
  sh -c 'printf "\000\000\047\017" | dd of=/data/marfa.db bs=1 seek=60 count=4 conv=notrunc 2>/dev/null'
refused=marfa-check-refused-$$
containers+=("$refused")
docker run -d --name "$refused" --read-only --restart unless-stopped \
  --mount "type=volume,source=$volume,target=/data" "$image" >/dev/null
says_refused() { grep -q "will not start on the database" <<<"$(docker logs "$refused" 2>&1)"; }
until_true "the refusal in the log" 60 says_refused
sleep 10
[ "$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$refused")" = "true 0" ] \
  || fail "on a refused database the container did not stay up without restarting"
stop_and_check "$refused"

echo "the image holds to what it says it is"
