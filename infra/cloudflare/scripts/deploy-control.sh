#!/usr/bin/env bash
#
# Deploy the runtime-control Worker by rendering the templated
# wrangler.control.toml against the calling shell's environment and
# invoking `wrangler deploy`. T-252 — closes the manual
# substitute-deploy-revert ritual that preceded this script.
#
# Usage:
#   ./infra/cloudflare/scripts/deploy-control.sh <staging|prod> [extra wrangler args]
#
# Required env (operator-specific):
#   - CLOUDFLARE_API_TOKEN              (marfa-account token)
#   - CLOUDFLARE_ACCOUNT_ID             (account hosting the Worker)
#   - CONTROL_PLANE_STAGING_KV_ID       (idempotency KV namespace id, staging)
#   - CONTROL_PLANE_PROD_KV_ID          (idempotency KV namespace id, prod)
#   - CONTROL_PLANE_STAGING_HOSTNAME    (e.g. runtime-staging.marfa.so)
#   - CONTROL_PLANE_PROD_HOSTNAME       (e.g. runtime.marfa.so)
#   - CONTROL_PLANE_ZONE                (zone hosting both, e.g. marfa.so)
#
# Example invocation from an operator shell that already sources the
# per-machine secrets file:
#
#   ./infra/cloudflare/scripts/deploy-control.sh staging
#
# What this does:
#   1. Validates the required env vars are set (fail-loud on any missing).
#   2. Renders wrangler.control.toml → a temp file with `${VAR}` tokens
#      substituted by the env values (envsubst-equivalent).
#   3. Pre-builds the runtime-control Worker's workspace deps via
#      `pnpm --filter @withmarfa/runtime-control... --if-present build`
#      (per scripts/deploy-worker.sh — keeps the bundled dist fresh
#      across workspace changes).
#   4. Runs `wrangler deploy --config <temp> --env <env>` with any extra
#      args appended verbatim.
#   5. Removes the temp file on exit (trap ensures cleanup on error).
#
# The temp file lives inside `infra/cloudflare/` so wrangler's
# relative-path resolution for `main = ../../packages/runtime-control/src/index.ts`
# keeps working.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod> [extra wrangler args]" >&2
  exit 1
fi
shift

# Universal requirements (both envs need these).
REQUIRED_VARS=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CONTROL_PLANE_ZONE)
# Env-specific requirements. The opposite env's vars only need to
# parse syntactically since wrangler is told `--env <env>`; we
# default the unused side to a syntactically-valid sentinel so a
# staging-only operator doesn't need to mint a prod KV namespace.
if [[ "$ENV_NAME" == "staging" ]]; then
  REQUIRED_VARS+=(CONTROL_PLANE_STAGING_KV_ID CONTROL_PLANE_STAGING_HOSTNAME)
  : "${CONTROL_PLANE_PROD_KV_ID:=00000000000000000000000000000000}"
  : "${CONTROL_PLANE_PROD_HOSTNAME:=runtime.invalid}"
  export CONTROL_PLANE_PROD_KV_ID CONTROL_PLANE_PROD_HOSTNAME
else
  REQUIRED_VARS+=(CONTROL_PLANE_PROD_KV_ID CONTROL_PLANE_PROD_HOSTNAME)
  : "${CONTROL_PLANE_STAGING_KV_ID:=00000000000000000000000000000000}"
  : "${CONTROL_PLANE_STAGING_HOSTNAME:=runtime-staging.invalid}"
  export CONTROL_PLANE_STAGING_KV_ID CONTROL_PLANE_STAGING_HOSTNAME
fi
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done
if (( ${#MISSING[@]} > 0 )); then
  echo "error: required env vars not set:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  echo "" >&2
  echo "Export them (e.g. from your per-machine secrets file)" >&2
  echo "and set the CONTROL_PLANE_* values before invoking this script." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_TOML="$INFRA_DIR/wrangler.control.toml"
# Temp file inside infra/cloudflare/ so wrangler resolves the
# `main = ../../packages/...` relative path correctly.
RENDERED_TOML="$INFRA_DIR/.wrangler.control.rendered.toml"

cleanup() {
  rm -f "$RENDERED_TOML"
}
trap cleanup EXIT

# envsubst substitutes only the listed variable references. The
# allowlist prevents stray ${X} sequences (e.g. in a comment) from
# being silently blanked.
TEMPLATE_VARS='${CLOUDFLARE_ACCOUNT_ID} ${CONTROL_PLANE_STAGING_KV_ID} ${CONTROL_PLANE_PROD_KV_ID} ${CONTROL_PLANE_STAGING_HOSTNAME} ${CONTROL_PLANE_PROD_HOSTNAME} ${CONTROL_PLANE_ZONE}'

echo "→ Rendering wrangler.control.toml against env vars"
envsubst "$TEMPLATE_VARS" < "$SOURCE_TOML" > "$RENDERED_TOML"

# Sanity check: any unresolved `${VAR}` left in the rendered output is
# a bug (typo in the toml, gap in TEMPLATE_VARS, or an unset env var
# the check above missed).
UNRESOLVED="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$RENDERED_TOML" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "error: rendered toml contains unresolved tokens:" >&2
  echo "$UNRESOLVED" | sort -u | sed 's/^/  /' >&2
  exit 1
fi

# Diff against the live deployment when wrangler exposes one.
echo "→ Rendered config preview (key bindings only):"
grep -E '^name|^\[env\.[a-z]+\]|routes|kv_namespaces|account_id|CLOUDFLARE_ACCOUNT_ID' "$RENDERED_TOML" | sed 's/^/  /'

# Pre-build workspace deps so the bundle picks up fresh dist artefacts —
# mirrors scripts/deploy-worker.sh's T-251 behaviour. runtime-control
# itself has no `build` script (bundled via wrangler), so this only
# rebuilds upstream deps (@withmarfa/shared, @withmarfa/webhooks).
echo "→ Pre-building workspace deps for @withmarfa/runtime-control"
pnpm --filter "@withmarfa/runtime-control..." --if-present build

echo "→ wrangler deploy --config <rendered> --env $ENV_NAME"
# Not `exec` — exec replaces the shell process, which would bypass
# the EXIT trap and leak the rendered toml on disk.
wrangler deploy --config "$RENDERED_TOML" --env "$ENV_NAME" "$@"
