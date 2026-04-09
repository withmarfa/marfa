#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Myme deploy script
#
# Deploys the Myme server to a remote host via SSH + git pull.
# Both production (:8600) and staging (:8601) share the same code directory
# with different launchd plists, so a deploy updates both environments.
#
# Usage:
#   ./deploy.sh                Deploy latest main
#   ./deploy.sh --rollback     Rollback to previous SHA
# ---------------------------------------------------------------------------

# --- Configuration (override via environment) ---
ATLAS_HOST="${ATLAS_HOST:-atlas}"
SERVICE_DIR="${SERVICE_DIR:-\$HOME/Services/myme}"
REPO_BRANCH="${REPO_BRANCH:-main}"

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
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

# --- Helper: run a command on the remote host ---
remote() {
  # shellcheck disable=SC2029
  ssh "$ATLAS_HOST" "cd $SERVICE_DIR && $1"
}

remote_raw() {
  ssh "$ATLAS_HOST" "$1"
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

restart_services() {
  echo "  Restarting production..."
  remote_raw "launchctl unload ~/Library/LaunchAgents/com.myme.server.plist 2>/dev/null; sleep 1; launchctl load ~/Library/LaunchAgents/com.myme.server.plist"
  echo "  Restarting staging..."
  remote_raw "launchctl unload ~/Library/LaunchAgents/com.myme.staging.plist 2>/dev/null; sleep 1; launchctl load ~/Library/LaunchAgents/com.myme.staging.plist"
}

health_check() {
  local label="$1"
  local port="$2"
  for i in 1 2 3; do
    sleep 2
    if remote_raw "curl -sf http://localhost:$port/health" > /dev/null 2>&1; then
      echo -e "  ${GREEN}$label: ok${NC}"
      return 0
    fi
    echo "  $label: attempt $i/3 failed, retrying..."
  done
  echo -e "  ${RED}$label: health check failed${NC}"
  return 1
}

echo -e "${GREEN}Deploying Myme to $ATLAS_HOST${NC}"
echo ""

# --- Step 1: Pre-flight checks ---
echo "1/6 Pre-flight checks..."
if ! ssh -o ConnectTimeout=5 "$ATLAS_HOST" "echo ok" > /dev/null 2>&1; then
  echo -e "${RED}Cannot connect to $ATLAS_HOST via SSH.${NC}"
  echo "  Configure SSH access in ~/.ssh/config:"
  echo "    Host atlas"
  echo "      HostName <your-tailscale-ip>"
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

  echo "3/6 Building..."
  remote "pnpm install --frozen-lockfile && pnpm build"

  echo "4/6 Writing version file..."
  remote "echo '{\"sha\": \"$ROLLBACK_SHA\", \"previous_sha\": \"$PREVIOUS_SHA\", \"deployed_at\": \"$(timestamp)\", \"rollback\": true}' > version.json"

  echo "5/6 Restarting services..."
  restart_services

  echo "6/6 Health checks..."
  health_check "Production" 8600
  health_check "Staging" 8601

  echo -e "${GREEN}Rollback complete.${NC}"
  remote "echo \"$(timestamp) ROLLBACK $ROLLBACK_SHA (from $PREVIOUS_SHA)\" >> deploy.log"
  exit 0
fi

# --- Normal deploy flow ---

# --- Step 2: Git pull ---
echo "2/6 Pulling latest from $REPO_BRANCH..."
remote "git fetch origin && git checkout $REPO_BRANCH && git pull origin $REPO_BRANCH"
NEW_SHA=$(remote "git rev-parse HEAD")
echo "  SHA: $NEW_SHA"

if [ "$NEW_SHA" = "$PREVIOUS_SHA" ]; then
  echo -e "${YELLOW}Already running $NEW_SHA. Nothing to deploy.${NC}"
  exit 0
fi

# --- Step 3: Build ---
echo "3/6 Building..."
remote "pnpm install --frozen-lockfile && pnpm build"

# --- Step 4: Write version file ---
echo "4/6 Writing version file..."
remote "echo '{\"sha\": \"$NEW_SHA\", \"previous_sha\": \"$PREVIOUS_SHA\", \"deployed_at\": \"$(timestamp)\"}' > version.json"

# --- Step 5: Restart both services ---
echo "5/6 Restarting services..."
restart_services

# --- Step 6: Health checks ---
echo "6/6 Health checks..."
FAILED=false
health_check "Production" 8600 || FAILED=true
health_check "Staging" 8601 || FAILED=true

if [ "$FAILED" = true ]; then
  echo -e "${RED}One or more health checks failed. Consider rolling back:${NC}"
  echo "  ./deploy.sh --rollback"
  exit 1
fi

echo -e "${GREEN}Deploy successful.${NC}"
echo "  SHA: $NEW_SHA"
echo "  Previous: ${PREVIOUS_SHA:-none}"
remote "echo \"$(timestamp) DEPLOY $NEW_SHA\" >> deploy.log"
