#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Myme deploy script
#
# Deploys the Myme server via SSH + git pull.
#
# Topology:
#   - :8602  so.myme.staging      — active instance (Postgres: myme_staging)
#   - :8601  so.myme.conformance  — conformance instance (Postgres: myme_conformance)
#
# Both services share a single source tree at ~/Services/myme-staging/
# and separate launchd plists. A deploy rebuilds once and restarts both
# launchd services.
#
# Usage:
#   ./deploy.sh                Deploy latest main (restarts both services)
#   ./deploy.sh --rollback     Rollback to previous SHA recorded in version.json
#   ./deploy.sh --host myhost  Override SSH host
# ---------------------------------------------------------------------------

# --- Configuration (override via environment) ---
ATLAS_HOST="${ATLAS_HOST:-aic-atlas}"
SERVICE_DIR="${SERVICE_DIR:-\$HOME/Services/myme-staging}"
REPO_BRANCH="${REPO_BRANCH:-main}"

# SSH hardening — cap any single ssh invocation at ~45s instead of waiting
# indefinitely. ConnectTimeout fails fast if Atlas is unreachable;
# ServerAliveInterval + ServerAliveCountMax detect a stalled mid-session
# tunnel (3 × 15s = ~45s before the client gives up).
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)

# Services managed by this script. Paired arrays: label / port / database URL.
SERVICE_LABELS=("so.myme.staging" "so.myme.conformance")
SERVICE_NAMES=("staging" "conformance")
SERVICE_PORTS=(8602 8601)
SERVICE_DBS=(
  "${STAGING_DATABASE_URL:-postgres://myme:myme_prod@localhost:5432/myme_staging}"
  "${CONFORMANCE_DATABASE_URL:-postgres://myme:myme_prod@localhost:5432/myme_conformance}"
)

# --- Defaults ---
ROLLBACK=false

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# --- Argument parsing ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback)
      ROLLBACK=true
      shift
      ;;
    --host)
      ATLAS_HOST="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./deploy.sh [--rollback] [--host hostname]"
      echo ""
      echo "Deploys both staging (:8602) and conformance (:8601) from main."
      echo ""
      echo "Environment:"
      echo "  ATLAS_HOST                  SSH host (default: aic-atlas)"
      echo "  SERVICE_DIR                 Source tree (default: \$HOME/Services/myme-staging)"
      echo "  REPO_BRANCH                 Branch to deploy (default: main)"
      echo "  STAGING_DATABASE_URL        Postgres URL for the staging instance"
      echo "  CONFORMANCE_DATABASE_URL    Postgres URL for the conformance instance"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

# --- Helpers ---
remote() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$ATLAS_HOST" "cd $SERVICE_DIR && $1"
}

remote_raw() {
  ssh "${SSH_OPTS[@]}" "$ATLAS_HOST" "$1"
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

restart_services() {
  for i in "${!SERVICE_LABELS[@]}"; do
    local label="${SERVICE_LABELS[$i]}"
    local name="${SERVICE_NAMES[$i]}"
    echo "  Restarting $name ($label)..."
    # kickstart -k atomically kills + relaunches; eliminates the racy gap
    # between `unload` (port-free not guaranteed) and `load`.
    remote_raw "launchctl kickstart -k gui/\$(id -u)/$label"
  done
}

run_migrations() {
  for i in "${!SERVICE_NAMES[@]}"; do
    local name="${SERVICE_NAMES[$i]}"
    local url="${SERVICE_DBS[$i]}"
    echo "  Migrating $name DB..."
    if ! remote "STORAGE_DIALECT=pg DATABASE_URL='$url' pnpm --filter @mymehq/server migrate"; then
      echo -e "  ${RED}$name migration failed${NC}"
      return 1
    fi
  done
}

health_check() {
  local name="$1"
  local port="$2"
  for i in 1 2 3; do
    sleep 2
    if remote_raw "curl -sf http://localhost:$port/health" > /dev/null 2>&1; then
      echo -e "  ${GREEN}$name (:$port): ok${NC}"
      return 0
    fi
    echo "  $name (:$port): attempt $i/3 failed, retrying..."
  done
  echo -e "  ${RED}$name (:$port): health check failed${NC}"
  return 1
}

echo -e "${GREEN}Deploying Myme to $ATLAS_HOST${NC}"
echo ""

# --- Step 1: Pre-flight checks ---
echo "1/7 Pre-flight checks..."
if ! ssh "${SSH_OPTS[@]}" "$ATLAS_HOST" "echo ok" > /dev/null 2>&1; then
  echo -e "${RED}Cannot connect to $ATLAS_HOST via SSH.${NC}"
  echo "  Configure SSH access in ~/.ssh/config:"
  echo "    Host aic-atlas"
  echo "      HostName <tailscale-ip-or-hostname>"
  echo "      User <your-user>"
  exit 1
fi

# Record previous SHA for rollback
PREVIOUS_SHA=""
if remote "test -f version.json" 2>/dev/null; then
  PREVIOUS_SHA=$(remote "cat version.json" | python3 -c "import sys, json; print(json.load(sys.stdin).get('sha', ''))" 2>/dev/null || echo "")
fi

# --- Rollback mode ---
if [ "$ROLLBACK" = true ]; then
  ROLLBACK_SHA=$(remote "cat version.json" | python3 -c "import sys, json; print(json.load(sys.stdin).get('previous_sha', ''))" 2>/dev/null || echo "")
  if [ -z "$ROLLBACK_SHA" ]; then
    echo -e "${RED}No previous_sha recorded. Cannot rollback.${NC}"
    exit 1
  fi

  echo -e "${YELLOW}Rolling back to $ROLLBACK_SHA${NC}"
  remote "git fetch origin && git checkout $ROLLBACK_SHA"

  echo "1/4 Building..."
  remote "pnpm install --frozen-lockfile && pnpm build"

  echo "2/4 Writing version file..."
  remote "echo '{\"sha\": \"$ROLLBACK_SHA\", \"previous_sha\": \"$PREVIOUS_SHA\", \"deployed_at\": \"$(timestamp)\", \"rollback\": true}' > version.json"

  echo "3/4 Restarting services..."
  restart_services

  echo "4/4 Health checks..."
  FAILED=false
  for i in "${!SERVICE_NAMES[@]}"; do
    health_check "${SERVICE_NAMES[$i]}" "${SERVICE_PORTS[$i]}" || FAILED=true
  done

  if [ "$FAILED" = true ]; then
    echo -e "${RED}One or more health checks failed after rollback.${NC}"
    exit 1
  fi

  echo -e "${GREEN}Rollback complete.${NC}"
  remote "echo \"$(timestamp) ROLLBACK $ROLLBACK_SHA (from $PREVIOUS_SHA)\" >> deploy.log"
  exit 0
fi

# --- Normal deploy flow ---

# --- Step 2: Git pull ---
echo "2/7 Pulling latest from $REPO_BRANCH..."
remote "git fetch origin && git checkout $REPO_BRANCH && git pull --ff-only origin $REPO_BRANCH"
NEW_SHA=$(remote "git rev-parse HEAD")
echo "  SHA: $NEW_SHA"

if [ "$NEW_SHA" = "$PREVIOUS_SHA" ]; then
  echo -e "${YELLOW}Already running $NEW_SHA. Nothing to deploy.${NC}"
  exit 0
fi

# --- Step 3: Build ---
echo "3/7 Building..."
remote "pnpm install --frozen-lockfile && pnpm build"

# --- Step 4: Run migrations against both databases ---
# Forward-only — Drizzle migrations don't roll back automatically. The
# rollback flow above intentionally skips this step; if a deploy needs to
# undo schema changes, that's a manual operator decision.
echo "4/7 Running database migrations..."
run_migrations || { echo -e "${RED}Migrations failed; not restarting services.${NC}"; exit 1; }

# --- Step 5: Write version file ---
echo "5/7 Writing version file..."
remote "echo '{\"sha\": \"$NEW_SHA\", \"previous_sha\": \"$PREVIOUS_SHA\", \"deployed_at\": \"$(timestamp)\"}' > version.json"

# --- Step 6: Restart both services ---
echo "6/7 Restarting services..."
restart_services

# --- Step 7: Health checks ---
echo "7/7 Health checks..."
FAILED=false
for i in "${!SERVICE_NAMES[@]}"; do
  health_check "${SERVICE_NAMES[$i]}" "${SERVICE_PORTS[$i]}" || FAILED=true
done

if [ "$FAILED" = true ]; then
  echo -e "${RED}One or more health checks failed. Consider rolling back:${NC}"
  echo "  ./deploy.sh --rollback"
  exit 1
fi

echo -e "${GREEN}Deploy successful.${NC}"
echo "  SHA: $NEW_SHA"
echo "  Previous: ${PREVIOUS_SHA:-none}"
remote "echo \"$(timestamp) DEPLOY $NEW_SHA\" >> deploy.log"
