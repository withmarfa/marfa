#!/usr/bin/env bash
#
# Deploy the Marfa server Worker front + Container by rendering the
# templated server-container/wrangler.jsonc against env-specific values and
# invoking `wrangler deploy`. Mirrors deploy-control.sh's envsubst approach,
# but the env profile (name, route, vars) is computed here per <staging|prod>
# rather than via wrangler `--env` blocks (the flat config avoids wrangler's
# per-env non-inheritable-key friction for durable_objects/containers).
#
# Usage:
#   ./infra/cloudflare/scripts/deploy-server-container.sh <staging|prod> [extra wrangler args]
#
# Required env (operator-specific; source from the per-machine secrets file):
#   - CLOUDFLARE_API_TOKEN     (marfa-account token; export = $CLOUDFLARE_API_TOKEN_MARFA)
#   - CLOUDFLARE_ACCOUNT_ID    (marfa account id)
#
# Optional env:
#   - SERVER_IMAGE_TAG         (image tag in the managed registry; default "staging"/"prod")
#   - SERVER_IMAGE             (full registry ref; overrides the derived one)
#   - V_BLOB_BACKEND           ("s3" once R2 creds exist; default "fs" for staging validation)
#   - S3_ENDPOINT              (R2 S3-API endpoint; default derives the standard-jurisdiction
#                               host — override for a jurisdiction-restricted bucket, e.g. EU)
#   - SERVER_SLEEP_AFTER       (container idle scale-to-zero timer; default "20m")
#   - STAGING_WORKERS_SUBDOMAIN (account workers.dev subdomain, for the staging auth base URL)
#
# The image must already be built (linux/amd64) and pushed to the managed
# registry via:
#   docker buildx build --platform linux/amd64 -f packages/server/Dockerfile \
#     -t marfa-server:<tag> --load .
#   wrangler containers push marfa-server:<tag>
# (CI does this on the self-hosted runner — see .github/workflows/deploy-server-container.yml.)
# Secrets are set separately via init-server-container-secrets.sh.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod> [extra wrangler args]" >&2
  exit 1
fi
shift || true

REQUIRED_VARS=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!var:-}" ]] && MISSING+=("$var")
done
if (( ${#MISSING[@]} > 0 )); then
  echo "error: required env vars not set:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 1
fi

# Shared / derived.
export SERVER_INSTANCE_TYPE="standard-1"
export SERVER_MAX_INSTANCES="1"
export SERVER_SLEEP_AFTER="${SERVER_SLEEP_AFTER:-20m}"
export V_EMAIL_FROM="Marfa <hello@mail.marfa.so>"
export V_OTEL_LOGS_ENDPOINT="https://eu.i.posthog.com/i/v1/logs"
# R2 S3-API endpoint for blob storage. The default-jurisdiction R2 endpoint is
# `<account>.r2.cloudflarestorage.com`; jurisdiction-restricted buckets (e.g.
# EU) use `<account>.<jurisdiction>.r2.cloudflarestorage.com` instead. The
# endpoint must match the bucket's jurisdiction or every S3 op returns
# NoSuchBucket — set S3_ENDPOINT to override the derived default.
export V_S3_ENDPOINT="${S3_ENDPOINT:-https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com}"
# Default to fs until R2 S3-API credentials are minted (see operator notes);
# flip to s3 by exporting V_BLOB_BACKEND=s3 once the secrets are set.
export V_BLOB_BACKEND="${V_BLOB_BACKEND:-fs}"

if [[ "$ENV_NAME" == "staging" ]]; then
  export SERVER_WORKER_NAME="marfa-server-staging"
  export SERVER_WORKERS_DEV="true"
  export SERVER_ROUTES="[]"
  export V_RUNTIME_CONTROL_URL="https://runtime-staging.marfa.so"
  export V_S3_BUCKET="marfa-blobs-staging"
  # workers.dev URL drives auth cookies. Defaults to the conventional host;
  # override STAGING_WORKERS_SUBDOMAIN if the account subdomain differs.
  SUB="${STAGING_WORKERS_SUBDOMAIN:-}"
  if [[ -n "$SUB" ]]; then
    export V_AUTH_BASE_URL="https://marfa-server-staging.${SUB}.workers.dev"
  else
    export V_AUTH_BASE_URL="${STAGING_API_BASE_URL:-https://marfa-server-staging.workers.dev}"
  fi
  export V_CORS_ORIGINS="${STAGING_CORS_ORIGINS:-$V_AUTH_BASE_URL}"
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-staging}"
else
  export SERVER_WORKER_NAME="marfa-server"
  export SERVER_WORKERS_DEV="false"
  export SERVER_ROUTES='[{"pattern":"api.marfa.so","custom_domain":true}]'
  export V_RUNTIME_CONTROL_URL="https://runtime.marfa.so"
  export V_S3_BUCKET="${PROD_R2_BUCKET:-marfa-blobs-prod}"
  export V_AUTH_BASE_URL="https://api.marfa.so"
  export V_CORS_ORIGINS="${PROD_CORS_ORIGINS:-https://api.marfa.so}"
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-prod}"
fi

export SERVER_IMAGE="${SERVER_IMAGE:-registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/marfa-server:${SERVER_IMAGE_TAG}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/../server-container" && pwd)"
SOURCE_JSONC="$PKG_DIR/wrangler.jsonc"
RENDERED_JSONC="$PKG_DIR/.wrangler.rendered.jsonc"

cleanup() { rm -f "$RENDERED_JSONC"; }
trap cleanup EXIT

TEMPLATE_VARS='${SERVER_WORKER_NAME} ${CLOUDFLARE_ACCOUNT_ID} ${SERVER_WORKERS_DEV} ${SERVER_ROUTES} ${SERVER_IMAGE} ${SERVER_INSTANCE_TYPE} ${SERVER_MAX_INSTANCES} ${SERVER_SLEEP_AFTER} ${V_BLOB_BACKEND} ${V_AUTH_BASE_URL} ${V_CORS_ORIGINS} ${V_RUNTIME_CONTROL_URL} ${V_EMAIL_FROM} ${V_S3_BUCKET} ${V_S3_ENDPOINT} ${V_OTEL_LOGS_ENDPOINT}'

echo "→ Rendering server-container/wrangler.jsonc for $ENV_NAME"
envsubst "$TEMPLATE_VARS" < "$SOURCE_JSONC" > "$RENDERED_JSONC"

UNRESOLVED="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$RENDERED_JSONC" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "error: rendered config has unresolved tokens:" >&2
  echo "$UNRESOLVED" | sort -u | sed 's/^/  /' >&2
  exit 1
fi

echo "→ Rendered config preview:"
grep -E '"name"|"image"|"instance_type"|"max_instances"|workers_dev|routes|BLOB_BACKEND|MARFA_AUTH_BASE_URL' "$RENDERED_JSONC" | sed 's/^/  /'

echo "→ wrangler deploy --config <rendered> ($ENV_NAME)"
wrangler deploy --config "$RENDERED_JSONC" "$@"
