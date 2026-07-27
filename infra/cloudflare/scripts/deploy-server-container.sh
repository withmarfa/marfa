#!/usr/bin/env bash
#
# Deploy the Marfa server Worker front + Container by rendering the
# templated server-container/wrangler.jsonc against env-specific values and
# invoking `wrangler deploy`. Mirrors deploy-control.sh's envsubst approach,
# but the env profile (name, route, vars) is computed here per <staging|prod>
# rather than via wrangler `--env` blocks (the flat config avoids wrangler's
# per-env non-inheritable-key friction for durable_objects/containers).
#
# PRIMARY deploy path is the `Deploy server container` GitHub workflow
# (.github/workflows/deploy-server-container.yml), which builds the image
# natively on a hosted amd64 runner, runs migrate-then-deploy, and calls this
# script for the deploy step:
#     gh workflow run deploy-server-container.yml -f environment=staging
# This script is the LOCAL FALLBACK: run it by hand only when CI is unavailable.
# It needs a working local Docker daemon to build the image first (slow on
# Apple Silicon — the linux/amd64 image cross-compiles via emulation).
#
# Usage:
#   ./infra/cloudflare/scripts/deploy-server-container.sh <staging|prod> [extra wrangler args]
#
# Required env (operator-specific; source from the per-machine secrets file):
#   - CLOUDFLARE_API_TOKEN     (marfa-account token; export = $CLOUDFLARE_API_TOKEN_MARFA)
#   - CLOUDFLARE_ACCOUNT_ID    (marfa account id)
#
# Migrate-before-deploy (canonical ordering: migrate-then-deploy):
#   Unless SKIP_MIGRATE=1, this runs pending Drizzle migrations against the
#   target env's DIRECT (unpooled) Neon URL BEFORE rolling the container. The
#   server does not migrate on boot, so a schema-bearing image would otherwise
#   crash-loop against the old schema (Cloudflare surfaces it as a generic
#   "Failed to start container" 500 that masks the cause). A failed migration
#   aborts the deploy (set -e) — the container is never rolled against an
#   unmigrated DB. Required for the migrate step (unless SKIP_MIGRATE=1):
#     - staging: NEON_DATABASE_URL_STAGING (or legacy NEON_DATABASE_URL_MARFA)
#     - prod:    NEON_DATABASE_URL_PROD
#   The running app uses the POOLED URL (DATABASE_URL Worker secret, set by
#   init-server-container-secrets.sh) — only the migrate step uses the direct URL.
#   Ordering caveat: a constraint-TIGHTENING migration (e.g. a new UNIQUE index)
#   must not pre-date the code that keeps the data satisfying it — split it into
#   a later deploy than the code change. See migrate-server-db.sh.
#
# Optional env:
#   - SKIP_MIGRATE             (set to 1 to skip the pre-deploy migrate step;
#                               only when the DB is known to be already migrated)
#   - SERVER_IMAGE_TAG         (image tag in the managed registry; default is an
#                               IMMUTABLE per-build tag "<env>-<short-git-sha>",
#                               e.g. "staging-1a2b3c4")
#   - SERVER_IMAGE             (full registry ref; overrides the derived one)
#   - V_BLOB_BACKEND           ("s3" once R2 creds exist; default "fs" for staging validation)
#   - SKIP_S3_CRED_CHECK       (set to 1 to bypass the s3 credential guard that
#                               otherwise blocks a BLOB_BACKEND=s3 deploy when the
#                               Worker lacks the S3 secrets)
#   - S3_ENDPOINT              (R2 S3-API endpoint; default derives the standard-jurisdiction
#                               host — override for a jurisdiction-restricted bucket, e.g. EU)
#   - SERVER_SLEEP_AFTER       (container idle scale-to-zero timer; default "20m")
#   - V_CONTAINER_WARM         (deliberate warm policy; "true" keeps the single
#                               instance resident instead of scaling to zero so
#                               the first request after an idle gap never pays a
#                               cold start. Default "false" (scale-to-zero) for
#                               both envs — an always-on container bills
#                               continuously (memory + disk + its managing
#                               Durable Object). Set "true" to opt a genuinely
#                               latency-sensitive env into always-on)
#   - STAGING_WORKERS_SUBDOMAIN (account workers.dev subdomain, for the staging auth base URL)
#
# The image must already be built (linux/amd64) and pushed to the managed
# registry under the SAME tag this script resolves. The default tag is the
# IMMUTABLE per-build "<env>-<short-git-sha>" — a fresh tag per commit, so a
# new image never reuses an existing reference string. This matters because
# `wrangler deploy` diffs the rendered config: if the image reference is byte-
# identical to what's deployed (e.g. new bits pushed to a mutable ":staging"
# tag), wrangler reports "no changes to be made" and does NOT roll the new
# image — the container serves stale bits while the deploy looks successful.
# A SHA-suffixed tag changes the reference on every build, forcing the roll.
#
# Build → push → deploy, all on the same commit's SHA tag:
#   TAG="<env>-$(git rev-parse --short HEAD)"   # e.g. staging-1a2b3c4
#   docker buildx build --platform linux/amd64 -f packages/server/Dockerfile \
#     -t "marfa-server:$TAG" --load .
#   wrangler containers push "marfa-server:$TAG"
#   ./infra/cloudflare/scripts/deploy-server-container.sh <staging|prod>
# The deploy step recomputes the same default tag from the current HEAD, so as
# long as the working tree is on the commit you built, the tags line up with no
# extra wiring. (CI passes the tag explicitly via SERVER_IMAGE_TAG — see
# .github/workflows/deploy-server-container.yml.) To deploy an arbitrary
# pre-pushed tag, export SERVER_IMAGE_TAG (or the full SERVER_IMAGE) instead.
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Immutable per-build image tag: "<env>-<short-git-sha>". Defaulting to a tag
# that changes every commit is the whole point — a mutable ":staging" tag lets
# `wrangler deploy` see an unchanged image reference and skip the roll ("no
# changes to be made"), leaving the container on stale bits. An explicit
# SERVER_IMAGE_TAG / SERVER_IMAGE override still wins (set per-env below).
GIT_SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
if [[ -z "$GIT_SHA" && -z "${SERVER_IMAGE_TAG:-}" && -z "${SERVER_IMAGE:-}" ]]; then
  echo "error: could not resolve a git SHA for the default image tag." >&2
  echo "  run from inside the repo, or set SERVER_IMAGE_TAG / SERVER_IMAGE explicitly." >&2
  exit 1
fi

# Migrate-then-deploy: apply pending schema migrations against the direct Neon
# URL BEFORE rolling the container. set -e aborts the whole deploy if this
# fails, so the container is never rolled against an unmigrated DB.
if [[ "${SKIP_MIGRATE:-}" == "1" ]]; then
  echo "→ SKIP_MIGRATE=1 — skipping pre-deploy migration (operator asserts DB already migrated)"
else
  "$SCRIPT_DIR/migrate-server-db.sh" "$ENV_NAME"
  # Seed the fixed first-party OAuth clients after migrations (idempotent) so a
  # DB reset self-heals on the next deploy — the browser apps use stable
  # client_ids rather than per-browser DCR.
  "$SCRIPT_DIR/seed-server-oauth-clients.sh" "$ENV_NAME"
fi

# Shared / derived.
export SERVER_INSTANCE_TYPE="standard-1"
# Load-bearing, not a capacity choice. The OAuth consent flows serialize their
# writes to a user's standing grant through an in-process mutex, which only
# covers one process. Raise this and a permission the user just revoked can
# come back, silently and without an error anywhere. Scaling out needs a
# shared lock first — see the consent-skip notes in packages/server/AGENTS.md.
export SERVER_MAX_INSTANCES="1"
export V_EMAIL_FROM="Marfa <hello@mail.marfa.so>"
export V_OTEL_LOGS_ENDPOINT="https://eu.i.posthog.com/i/v1/logs"
# Hosted containers delegate integrations to the Cloudflare substrate (control
# plane + per-Integration Workers + Queues), not the in-process Node/pg-boss
# one. The server code defaults to "local" so a self-host `docker compose up`
# needs no Cloudflare account; the hosted deploy sets it explicitly. Reactive
# runs + schedule arming also need the broker key + queue secrets — set those
# via `MARFA_SET_QUEUES=1 init-server-container-secrets.sh <env>`.
export V_INTEGRATION_RUNTIME="hosted"
# R2 S3-API endpoint for blob storage. The default-jurisdiction R2 endpoint is
# `<account>.r2.cloudflarestorage.com`; jurisdiction-restricted buckets (e.g.
# EU) use `<account>.<jurisdiction>.r2.cloudflarestorage.com` instead. The
# endpoint must match the bucket's jurisdiction or every S3 op returns
# NoSuchBucket — set S3_ENDPOINT to override the derived default.
export V_S3_ENDPOINT="${S3_ENDPOINT:-https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com}"
# Default to fs until R2 S3-API credentials are minted (see operator notes);
# flip to s3 by exporting V_BLOB_BACKEND=s3 once the secrets are set. When s3 is
# requested, the credential guard below refuses to deploy unless the Worker
# already carries the S3 secrets — so an s3 cutover can't silently ship broken
# blob writes.
export V_BLOB_BACKEND="${V_BLOB_BACKEND:-fs}"

if [[ "$ENV_NAME" == "staging" ]]; then
  export SERVER_WORKER_NAME="marfa-server-staging"
  export SERVER_WORKERS_DEV="true"
  export SERVER_ROUTES="[]"
  # Tag staging telemetry so its logs are distinguishable from prod's in their
  # separate PostHog projects (the container's NODE_ENV is "production" on both,
  # so the OTel bootstrap can't derive this).
  export V_OTEL_ENVIRONMENT="staging"
  # Aggressive scale-to-zero on staging: idle awake-time is the dominant driver
  # of Neon compute, and staging's free budget is the one that keeps lapsing.
  export SERVER_SLEEP_AFTER="${SERVER_SLEEP_AFTER:-2m}"
  # Deliberate warm policy — OFF by default (opt-in). Warm keeps the single
  # instance resident so the first request after an idle gap never pays a cold
  # start (staging backs the Tickets responsiveness surface). COST: an always-on
  # container bills continuously — provisioned memory + disk for the whole
  # resident window plus its managing Durable Object (~$12.50/mo floor), on the
  # order of tens of dollars/month per instance. Off = scale-to-zero on the 2m
  # timer above, so an untouched env costs ~nothing. Set V_CONTAINER_WARM=true
  # to opt a genuinely latency-sensitive env back in.
  export V_CONTAINER_WARM="${V_CONTAINER_WARM:-false}"
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
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-staging-${GIT_SHA}}"
else
  export SERVER_WORKER_NAME="marfa-server"
  export SERVER_WORKERS_DEV="false"
  export SERVER_ROUTES='[{"pattern":"api.marfa.so","custom_domain":true}]'
  export V_OTEL_ENVIRONMENT="production"
  # Prod has its own free Neon budget, so a longer idle window is affordable and
  # keeps the dogfooding instance warm. Tune down if prod compute creeps up.
  export SERVER_SLEEP_AFTER="${SERVER_SLEEP_AFTER:-10m}"
  # Deliberate warm policy — OFF by default (opt-in). Warm keeps the prod
  # instance resident so real traffic never pays a cold start. COST: an
  # always-on container bills continuously — provisioned memory + disk plus its
  # managing Durable Object (~$12.50/mo floor). Off = scale-to-zero, so a
  # low-traffic or idle deployment costs ~nothing. Set V_CONTAINER_WARM=true
  # once sustained real traffic makes the latency floor worth the spend.
  export V_CONTAINER_WARM="${V_CONTAINER_WARM:-false}"
  export V_RUNTIME_CONTROL_URL="https://runtime.marfa.so"
  export V_S3_BUCKET="${PROD_R2_BUCKET:-marfa-blobs-prod}"
  export V_AUTH_BASE_URL="https://api.marfa.so"
  export V_CORS_ORIGINS="${PROD_CORS_ORIGINS:-https://api.marfa.so}"
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-prod-${GIT_SHA}}"
fi

# Durability guard: a BLOB_BACKEND=s3 deploy must not roll unless the Worker
# already carries the S3 credential secrets. Without them the server boots fine
# but every blob upload fails at the S3 layer (the durability win silently
# regresses to broken). The secrets are set out-of-band by
# init-server-container-secrets.sh, so we check the live secret list rather than
# the local shell. Skip with SKIP_S3_CRED_CHECK=1 only when you know the Worker
# already has them (e.g. an unrelated redeploy where a list call would just add
# latency).
if [[ "$V_BLOB_BACKEND" == "s3" && "${SKIP_S3_CRED_CHECK:-}" != "1" ]]; then
  echo "→ BLOB_BACKEND=s3 — verifying S3 credential secrets on $SERVER_WORKER_NAME"
  SECRET_LIST="$(wrangler secret list --name "$SERVER_WORKER_NAME" 2>/dev/null || true)"
  MISSING_SECRETS=()
  for s in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    grep -q "\"$s\"" <<<"$SECRET_LIST" || MISSING_SECRETS+=("$s")
  done
  if (( ${#MISSING_SECRETS[@]} > 0 )); then
    echo "error: BLOB_BACKEND=s3 but the Worker is missing S3 credential secret(s):" >&2
    printf '  - %s\n' "${MISSING_SECRETS[@]}" >&2
    echo "  Set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in your shell, then run:" >&2
    echo "    ./infra/cloudflare/scripts/init-server-container-secrets.sh $ENV_NAME" >&2
    echo "  (or export SKIP_S3_CRED_CHECK=1 if you are certain they are already set)." >&2
    exit 1
  fi
  echo "  ✓ S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY present"
fi

export SERVER_IMAGE="${SERVER_IMAGE:-registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/marfa-server:${SERVER_IMAGE_TAG}}"

echo "→ Image tag: $SERVER_IMAGE_TAG"
echo "→ Image ref: $SERVER_IMAGE"
echo "  (this exact tag must already be built + pushed — see the build→push→deploy"
echo "   sequence in this script's header; the default tag tracks the current HEAD)"

PKG_DIR="$(cd "$SCRIPT_DIR/../server-container" && pwd)"
SOURCE_JSONC="$PKG_DIR/wrangler.jsonc"
RENDERED_JSONC="$PKG_DIR/.wrangler.rendered.jsonc"
DEPLOY_LOG=""

cleanup() { rm -f "$RENDERED_JSONC" "${DEPLOY_LOG:-}"; }
trap cleanup EXIT

TEMPLATE_VARS='${SERVER_WORKER_NAME} ${CLOUDFLARE_ACCOUNT_ID} ${SERVER_WORKERS_DEV} ${SERVER_ROUTES} ${SERVER_IMAGE} ${SERVER_INSTANCE_TYPE} ${SERVER_MAX_INSTANCES} ${SERVER_SLEEP_AFTER} ${V_CONTAINER_WARM} ${V_BLOB_BACKEND} ${V_AUTH_BASE_URL} ${V_CORS_ORIGINS} ${V_RUNTIME_CONTROL_URL} ${V_INTEGRATION_RUNTIME} ${V_EMAIL_FROM} ${V_S3_BUCKET} ${V_S3_ENDPOINT} ${V_OTEL_LOGS_ENDPOINT} ${V_OTEL_ENVIRONMENT}'

echo "→ Rendering server-container/wrangler.jsonc for $ENV_NAME"
envsubst "$TEMPLATE_VARS" < "$SOURCE_JSONC" > "$RENDERED_JSONC"

UNRESOLVED="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$RENDERED_JSONC" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "error: rendered config has unresolved tokens:" >&2
  echo "$UNRESOLVED" | sort -u | sed 's/^/  /' >&2
  exit 1
fi

echo "→ Rendered config preview:"
grep -E '"name"|"image"|"instance_type"|"max_instances"|workers_dev|routes|BLOB_BACKEND|MARFA_AUTH_BASE_URL|MARFA_INTEGRATION_RUNTIME' "$RENDERED_JSONC" | sed 's/^/  /'

echo "→ wrangler deploy --config <rendered> ($ENV_NAME)"
# Capture the output so we can detect the silent-no-roll case below, while still
# streaming it live. PIPESTATUS preserves wrangler's exit code through the tee.
DEPLOY_LOG="$(mktemp)"
wrangler deploy --config "$RENDERED_JSONC" "$@" 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_RC="${PIPESTATUS[0]}"
if (( DEPLOY_RC != 0 )); then
  exit "$DEPLOY_RC"
fi

# Silent-no-roll guard. When the rendered image reference is byte-identical to
# what's already deployed, wrangler prints "no changes to be made" and skips the
# container roll — so a freshly pushed image under a reused tag never goes live.
# The default SHA-suffixed tag prevents this; warn loudly if it happens anyway
# (e.g. a redeploy of an already-deployed SHA, or an explicit mutable override).
# Not fatal: a genuine no-op redeploy is legitimate.
if grep -qiF "no changes to be made" "$DEPLOY_LOG"; then
  echo "" >&2
  echo "⚠⚠⚠ WARNING: wrangler reported \"no changes to be made\". ⚠⚠⚠" >&2
  echo "  The container app was NOT rolled. If you pushed new image bits under" >&2
  echo "  the SAME tag ($SERVER_IMAGE_TAG), they are NOT live — the server is" >&2
  echo "  still serving the previously deployed image for this reference." >&2
  echo "  Fix: rebuild + push under a fresh tag (the default <env>-<sha> changes" >&2
  echo "  per commit) and redeploy, or bump SERVER_IMAGE_TAG to force a new ref." >&2
fi
