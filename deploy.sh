#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Myme deploy script
#
# Deploys the Myme server to a remote host over SSH: git pull + build +
# migrate + restart. Manages one or more launchd-supervised service
# instances that share a single source tree (SERVICE_DIR).
#
# Every host-, service-, and database-specific value comes from the
# environment — nothing operator-specific is baked into this script. See
# the self-hosting docs for a worked example of the DEPLOY_SERVICE_* vars.
#
# Usage:
#   ./deploy.sh                Deploy latest main (restarts every service)
#   ./deploy.sh --rollback     Rollback to previous SHA recorded in version.json
#   ./deploy.sh --host myhost  Override SSH host
#
# Operator config: deploy.sh sources ./deploy.env (gitignored) when
# present. Copy deploy.env.example to deploy.env and fill it in.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/deploy.env" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/deploy.env"
fi

# --- Configuration (all via environment) ---
DEPLOY_HOST="${DEPLOY_HOST:-}"
SERVICE_DIR="${SERVICE_DIR:-\$HOME/myme}"
REPO_BRANCH="${REPO_BRANCH:-main}"

# SSH hardening — cap any single ssh invocation at ~45s instead of waiting
# indefinitely. ConnectTimeout fails fast if the host is unreachable;
# ServerAliveInterval + ServerAliveCountMax detect a stalled mid-session
# tunnel (3 × 15s = ~45s before the client gives up).
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)

# Services managed by this deploy. Each is described by the Nth entry of
# four comma-separated lists supplied via the environment — all four must
# be set and the same length:
#   DEPLOY_SERVICE_NAMES    — human-readable name per service
#   DEPLOY_SERVICE_LABELS   — launchd label per service (restart target)
#   DEPLOY_SERVICE_PORTS    — health-check port per service
#   DEPLOY_SERVICE_DB_URLS  — Postgres URL per service (migration target)
IFS=',' read -ra SERVICE_NAMES <<< "${DEPLOY_SERVICE_NAMES:-}"
IFS=',' read -ra SERVICE_LABELS <<< "${DEPLOY_SERVICE_LABELS:-}"
IFS=',' read -ra SERVICE_PORTS <<< "${DEPLOY_SERVICE_PORTS:-}"
IFS=',' read -ra SERVICE_DBS <<< "${DEPLOY_SERVICE_DB_URLS:-}"

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
      DEPLOY_HOST="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./deploy.sh [--rollback] [--host hostname]"
      echo ""
      echo "Deploys every configured service from the target branch."
      echo ""
      echo "Environment:"
      echo "  DEPLOY_HOST               SSH host (required; or pass via --host)"
      echo "  SERVICE_DIR               Source tree on the host (default: \$HOME/myme)"
      echo "  REPO_BRANCH               Branch to deploy (default: main)"
      echo "  DEPLOY_SERVICE_NAMES      Comma-separated service names (required)"
      echo "  DEPLOY_SERVICE_LABELS     Comma-separated launchd labels (required)"
      echo "  DEPLOY_SERVICE_PORTS      Comma-separated health-check ports (required)"
      echo "  DEPLOY_SERVICE_DB_URLS    Comma-separated Postgres URLs (required)"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

if [ -z "$DEPLOY_HOST" ]; then
  echo -e "${RED}DEPLOY_HOST is required (set in the environment or pass --host <hostname>).${NC}"
  exit 1
fi

if [ ${#SERVICE_NAMES[@]} -eq 0 ]; then
  echo -e "${RED}No services configured.${NC}"
  echo "  Set DEPLOY_SERVICE_NAMES, DEPLOY_SERVICE_LABELS, DEPLOY_SERVICE_PORTS,"
  echo "  and DEPLOY_SERVICE_DB_URLS — comma-separated, one entry per service."
  exit 1
fi

if [ ${#SERVICE_LABELS[@]} -ne ${#SERVICE_NAMES[@]} ] ||
  [ ${#SERVICE_PORTS[@]} -ne ${#SERVICE_NAMES[@]} ] ||
  [ ${#SERVICE_DBS[@]} -ne ${#SERVICE_NAMES[@]} ]; then
  echo -e "${RED}DEPLOY_SERVICE_* lists must all be the same length.${NC}"
  exit 1
fi

# --- Helpers ---
remote() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "cd $SERVICE_DIR && $1"
}

remote_raw() {
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$1"
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

echo -e "${GREEN}Deploying Myme to $DEPLOY_HOST${NC}"
echo ""

# --- Step 1: Pre-flight checks ---
echo "1/7 Pre-flight checks..."
if ! ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "echo ok" > /dev/null 2>&1; then
  echo -e "${RED}Cannot connect to $DEPLOY_HOST via SSH.${NC}"
  echo "  Configure SSH access in ~/.ssh/config:"
  echo "    Host $DEPLOY_HOST"
  echo "      HostName <hostname-or-ip>"
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
