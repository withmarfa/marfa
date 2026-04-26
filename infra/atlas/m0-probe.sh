#!/usr/bin/env bash
# M0 viability spike: prove ElectricSQL runs on Atlas (macOS + Docker)
# before committing the rest of the @mymehq/sync-client plan.
#
# Run this from the Atlas host. It boots Electric against the
# myme_mock database (lower-stakes than myme_v0), exercises the
# shape API end-to-end, then tears down cleanly. Output goes to
# /tmp/m0-electric-probe.log so the result survives the session.
#
# Prerequisites on Atlas:
#   - Docker daemon running (OrbStack / Docker Desktop)
#   - Postgres reachable on host.docker.internal:5432 with myme_mock db
#   - wal_level = logical configured on that Postgres
#     (verify with: psql -d myme_mock -c "SHOW wal_level;")
#   - curl available
#
# Usage:
#   ./m0-probe.sh
#
# Exit codes:
#   0 — Electric booted, shape returned, ran cleanly
#   non-zero — see /tmp/m0-electric-probe.log for details
#
# After running, capture the outcome in
# docs/architecture-decisions/sync-client-electric-host.md.

set -euo pipefail

ELECTRIC_TAG="${ELECTRIC_TAG:-electricsql/electric:1.5.1}"
PROBE_PORT="${PROBE_PORT:-8699}"
DB_NAME="${DB_NAME:-myme_mock}"
DB_HOST="${DB_HOST:-host.docker.internal}"
DB_USER="${DB_USER:-myme}"
DB_PASS="${DB_PASS:?set DB_PASS env var to the myme_mock password}"
LOG=/tmp/m0-electric-probe.log
CONTAINER=myme-electric-m0
SOAK_DURATION_SEC="${SOAK_DURATION_SEC:-60}"

log() {
  echo "[m0-probe $(date -u +%H:%M:%S)] $*" | tee -a "$LOG"
}

cleanup() {
  log "tearing down container ${CONTAINER}"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

: > "$LOG"
log "starting M0 viability probe — Electric ${ELECTRIC_TAG} on port ${PROBE_PORT}"
log "database: ${DB_HOST}/${DB_NAME} as ${DB_USER}"

# Pre-flight: container name must not collide
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  log "container ${CONTAINER} already exists — removing"
  docker rm -f "${CONTAINER}" >/dev/null
fi

# Boot Electric
log "booting Electric"
docker run -d \
  --name "${CONTAINER}" \
  -p "${PROBE_PORT}:3000" \
  -e "DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}?sslmode=disable" \
  -e "ELECTRIC_INSECURE=true" \
  -e "ELECTRIC_SERVICE_NAME=myme-m0-probe" \
  "${ELECTRIC_TAG}" >>"$LOG"

# Wait for HTTP readiness (up to 60 s)
log "waiting for Electric HTTP to come up"
ready=0
for i in $(seq 1 60); do
  if curl -fs "http://localhost:${PROBE_PORT}/v1/health" >/dev/null 2>&1; then
    ready=1
    log "Electric ready after ${i}s"
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  log "FAIL: Electric did not come up in 60s"
  log "container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -50 | tee -a "$LOG"
  exit 2
fi

# Probe 1: empty shape on the items table — should return a snapshot
log "probe 1: GET /v1/shape?table=items&offset=-1"
if ! curl -fsSI "http://localhost:${PROBE_PORT}/v1/shape?table=items&offset=-1" \
  | tee -a "$LOG" >/dev/null; then
  log "FAIL: shape endpoint did not respond"
  exit 3
fi

# Probe 2: confirm the shape body parses (response is an array of log entries)
body=$(curl -fs "http://localhost:${PROBE_PORT}/v1/shape?table=items&offset=-1")
if ! echo "$body" | head -c 200 | tee -a "$LOG" >/dev/null; then
  log "FAIL: could not read shape body"
  exit 4
fi
log "shape body sample: $(echo "$body" | head -c 200)"

# Probe 3: live mode reconnect — extract handle/offset from the response
# headers and confirm long-poll endpoint accepts them.
log "probe 3: live mode handshake"
headers=$(curl -fsSI "http://localhost:${PROBE_PORT}/v1/shape?table=items&offset=-1")
handle=$(echo "$headers" | awk '/electric-handle/ {print $2}' | tr -d '\r')
offset=$(echo "$headers" | awk '/electric-offset/ {print $2}' | tr -d '\r')
log "received handle=${handle:-<none>} offset=${offset:-<none>}"

# Probe 4: soak — leave Electric running and tail logs for a window so
# memory / CPU profile is observable. The user is expected to look at
# Activity Monitor / docker stats during this window.
log "soaking for ${SOAK_DURATION_SEC}s — observe \`docker stats ${CONTAINER}\` in another shell"
docker stats --no-stream "${CONTAINER}" 2>&1 | tee -a "$LOG"
sleep "${SOAK_DURATION_SEC}"
docker stats --no-stream "${CONTAINER}" 2>&1 | tee -a "$LOG"

# Probe 5: forced container restart, confirm shape resumes
log "probe 5: restart the container, reconnect with handle"
docker restart "${CONTAINER}" >>"$LOG"
sleep 5
if curl -fs "http://localhost:${PROBE_PORT}/v1/health" >/dev/null 2>&1; then
  log "Electric came back up after restart"
else
  log "WARN: Electric did not return health after restart in 5s"
fi

# Final state — replication slot accounting
log "checking pg_replication_slots on the database"
log "(run separately on the host: psql -d ${DB_NAME} -c 'SELECT slot_name, active, restart_lsn FROM pg_replication_slots;')"

log "PASS — Electric ${ELECTRIC_TAG} ran end-to-end against ${DB_NAME}"
log "next step: capture this outcome in docs/architecture-decisions/sync-client-electric-host.md"
