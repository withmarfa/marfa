#!/usr/bin/env bash
#
# Deploy the per-Integration Workers for one environment.
#
# Usage:
#   ./infra/cloudflare/scripts/deploy-integrations.sh <staging|prod> [options] [integration-dir ...]
#
# Options:
#   --dry-run    Print the deploy commands without running them.
#   --list       Print the resolved targets and exit.
#
# With no integration-dir arguments every in-tree Worker is deployed.
# Named arguments are directory names under integrations/ (e.g.
# `todoist`, `google-drive`), which narrows the run to those.
#
# Required env (operator-specific):
#   - CLOUDFLARE_API_TOKEN    (marfa-account token)
#   - CLOUDFLARE_ACCOUNT_ID   (account hosting the Workers)
#
# DEPLOY THE CONTROL PLANE FIRST.
#
#   ./infra/cloudflare/scripts/deploy-control.sh <env>
#
# Integration Workers gate their whole HTTP surface on the runtime
# broker key, and the control plane is the only caller of that surface.
# A Worker deployed ahead of the control plane refuses arm-schedule and
# verify until the control plane catches up. The reverse order is safe:
# the header the control plane presents is ignored by a Worker that
# does not yet check it.
#
# Each Worker also needs its three secrets set before its first queue
# dispatch will succeed. Fresh Workers, or any Worker after a broker
# key rotation, go through:
#
#   ./infra/cloudflare/scripts/init-integration-worker-secrets.sh \
#     integrations/<dir> <env>
#
# Afterwards, confirm the deployed surface actually closed:
#
#   pnpm --filter @withmarfa/infra-cloudflare run verify:worker-surface <env>
#
# Deploys run one at a time and the script stops at the first failure,
# so a partial rollout leaves the remaining Workers untouched rather
# than half-applied across the fleet.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod> [--dry-run] [--list] [integration-dir ...]" >&2
  exit 1
fi
shift

DRY_RUN=0
LIST_ONLY=0
FILTER_DIRS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --list) LIST_ONLY=1 ;;
    -*) echo "error: unknown option $arg" >&2; exit 1 ;;
    *) FILTER_DIRS+=("$arg") ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if (( DRY_RUN == 0 && LIST_ONLY == 0 )); then
  MISSING=()
  for var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    if [[ -z "${!var:-}" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    echo "error: required env vars not set:" >&2
    printf '  - %s\n' "${MISSING[@]}" >&2
    exit 1
  fi
fi

# Targets are discovered from the tree rather than listed here, so an
# integration added without touching this script is still deployed.
# Per-Integration Workers first, then the sibling Email Workers: an
# Email Worker forwards into the substrate the integration Workers
# serve, so it is the last thing that should start producing traffic.
CONFIGS=()
while IFS= read -r line; do
  CONFIGS+=("$line")
done < <(
  find "$REPO_ROOT/integrations" -mindepth 2 -maxdepth 2 -name wrangler.toml | sort
  find "$REPO_ROOT/integrations" -mindepth 3 -maxdepth 3 -name wrangler.toml | sort
)

TARGET_DIRS=()
TARGET_PKGS=()
for config in "${CONFIGS[@]}"; do
  pkg_dir="$(dirname "$config")"
  rel_dir="${pkg_dir#"$REPO_ROOT"/integrations/}"
  # The owning integration is the first path segment, so a nested
  # deployable (integrations/<name>/email-worker) filters under its
  # parent's name rather than needing one of its own.
  owner="${rel_dir%%/*}"
  if (( ${#FILTER_DIRS[@]} > 0 )); then
    match=0
    for want in "${FILTER_DIRS[@]}"; do
      if [[ "$owner" == "$want" ]]; then match=1; fi
    done
    (( match == 1 )) || continue
  fi
  pkg_name="$(node -p "require('$pkg_dir/package.json').name")"
  TARGET_DIRS+=("$rel_dir")
  TARGET_PKGS+=("$pkg_name")
done

if (( ${#TARGET_PKGS[@]} == 0 )); then
  echo "error: no integration Workers matched" >&2
  if (( ${#FILTER_DIRS[@]} > 0 )); then
    printf '  filter: %s\n' "${FILTER_DIRS[*]}" >&2
  fi
  exit 1
fi

echo "→ ${#TARGET_PKGS[@]} Worker(s) to deploy to $ENV_NAME:"
for i in "${!TARGET_PKGS[@]}"; do
  printf '    %-46s %s\n' "${TARGET_PKGS[$i]}" "integrations/${TARGET_DIRS[$i]}"
done

if (( LIST_ONLY == 1 )); then
  exit 0
fi

echo ""
echo "→ Reminder: deploy-control.sh $ENV_NAME must have run first."
echo ""

# Pre-build workspace deps so each Worker bundle picks up fresh dist
# artifacts. Wrangler bundles the integration source directly, but the
# workspace packages it imports are consumed from their dist output.
if (( DRY_RUN == 0 )); then
  echo "→ Pre-building workspace deps"
  pnpm --filter "@withmarfa/runtime-sdk..." --if-present build
fi

for i in "${!TARGET_PKGS[@]}"; do
  pkg="${TARGET_PKGS[$i]}"
  echo ""
  echo "→ [$((i + 1))/${#TARGET_PKGS[@]}] $pkg --env $ENV_NAME"
  if (( DRY_RUN == 1 )); then
    echo "    (dry run) pnpm --filter $pkg exec wrangler deploy --env $ENV_NAME"
  else
    pnpm --filter "$pkg" exec wrangler deploy --env "$ENV_NAME"
  fi
done

echo ""
echo "→ Done. Verify the surface actually closed:"
echo "    pnpm --filter @withmarfa/infra-cloudflare run verify:worker-surface $ENV_NAME"
