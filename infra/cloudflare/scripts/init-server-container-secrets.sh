#!/usr/bin/env bash
#
# Set the secrets for the Marfa server Container Worker. Mirrors
# init-integration-worker-secrets.sh. The Worker must already exist (deploy
# once first); after setting secrets, re-run the deploy so the container
# restarts and picks them up as process env (envVars reads `env` at launch).
#
# Usage:
#   ./infra/cloudflare/scripts/init-server-container-secrets.sh <staging|prod>
#
# Reads values from the calling shell's environment (source your per-machine
# secrets file first). Both the secret slots and the source env vars use
# consumer-scoped names, so a deployer with no knowledge of any particular
# operator's shell can run this. A handful of suffixed legacy names are still
# accepted as fallbacks, marked below; they are a compatibility shim and new
# deployments should not rely on them.
#
# The DATABASE_URL Worker secret is the POOLED (PgBouncer) endpoint and is
# resolved PER-ENV, with a backward-compat fallback to the legacy shared
# *_MARFA name so existing operator shells keep working:
#
#   DATABASE_URL  staging  <- NEON_DATABASE_URL_POOLED_STAGING || NEON_DATABASE_URL_POOLED_MARFA
#   DATABASE_URL  prod     <- NEON_DATABASE_URL_POOLED_PROD
#
# (Pre-deploy migrations use the DIRECT/unpooled URL instead — see
# migrate-server-db.sh. App = pooled, migrate = direct.)
#
# MARFA_DATABASE_URL_DIRECT is the DIRECT (unpooled, session-mode) endpoint,
# used by the app ONLY for streaming RLS: its session-level SET ROLE must not
# run on the transaction-mode pooled endpoint, where the role strands on a
# shared backend and is inherited by later, unrelated queries. Resolved per-env
# and REQUIRED — the container declares MARFA_DB_POOL_MODE=transaction, so the
# server refuses to boot without this:
#
#   MARFA_DATABASE_URL_DIRECT  staging  <- NEON_DATABASE_URL_STAGING || NEON_DATABASE_URL_MARFA
#   MARFA_DATABASE_URL_DIRECT  prod     <- NEON_DATABASE_URL_PROD
#
#   MARFA_AUTH_SECRET           <- MARFA_SERVER_AUTH_SECRET        (see "Stable secrets")
#   API_KEY_SALT                <- MARFA_SERVER_API_KEY_SALT       (see "Stable secrets")
#   CLOUDFLARE_EMAIL_API_TOKEN  <- CLOUDFLARE_API_TOKEN
#   OTEL_EXPORTER_OTLP_HEADERS  <- "Authorization=Bearer <per-env PostHog token>"
#     staging <- POSTHOG_PROJECT_KEY_STAGING
#     prod    <- POSTHOG_PROJECT_KEY_PROD || POSTHOG_PROJECT_KEY_MARFA (legacy)
#     (per-env so staging and prod telemetry land in separate PostHog projects)
# Optional (set only when the source var is present):
#   CLOUDFLARE_QUEUES_API_TOKEN <- CLOUDFLARE_API_TOKEN            (only if MARFA_SET_QUEUES=1)
#   CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS <- CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS
#   MARFA_RUNTIME_BROKER_KEY    <- MARFA_RUNTIME_BROKER_KEY
#   S3_ACCESS_KEY_ID            <- R2_ACCESS_KEY_ID                (R2 S3-API creds)
#   S3_SECRET_ACCESS_KEY        <- R2_SECRET_ACCESS_KEY
#
# Stable secrets (MARFA_AUTH_SECRET, API_KEY_SALT)
#
# These two are destructive to replace: a new API_KEY_SALT invalidates every API
# key on the deployment, and a new MARFA_AUTH_SECRET signs out every session.
# Cloudflare cannot read a secret back, so the previous value is gone the moment
# it is overwritten. The script therefore resolves them in this order:
#
#   1. An explicit MARFA_SERVER_AUTH_SECRET / MARFA_SERVER_API_KEY_SALT wins.
#   2. Otherwise, if the Worker already carries the secret, it is LEFT ALONE —
#      re-running this script to add one new secret must never take the
#      deployment's credentials with it.
#   3. Otherwise (genuine first-time init) a value is generated and PRINTED
#      once. Persist it immediately, e.g. into the per-machine secrets file.
#
# To replace them deliberately, set MARFA_ROTATE_SERVER_SECRETS=1 and expect
# every key and session on that environment to stop working.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: $0 <staging|prod>" >&2
  exit 1
fi
if [[ "$ENV_NAME" == "staging" ]]; then
  WORKER="marfa-server-staging"
else
  WORKER="marfa-server"
fi

put_secret() { # name value
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    echo "  – skip $name (source empty)"
    return
  fi
  printf '%s' "$value" | wrangler secret put "$name" --name "$WORKER" >/dev/null
  echo "  ✓ set $name"
}

# Resolve the POOLED app DB URL per-env, with a legacy fallback for staging.
if [[ "$ENV_NAME" == "staging" ]]; then
  POOLED_DB_URL="${NEON_DATABASE_URL_POOLED_STAGING:-${NEON_DATABASE_URL_POOLED_MARFA:-}}"
else
  POOLED_DB_URL="${NEON_DATABASE_URL_POOLED_PROD:-}"
fi
if [[ -z "$POOLED_DB_URL" ]]; then
  echo "error: no pooled Neon URL resolved for $ENV_NAME" >&2
  if [[ "$ENV_NAME" == "staging" ]]; then
    echo "  set NEON_DATABASE_URL_POOLED_STAGING (or legacy NEON_DATABASE_URL_POOLED_MARFA)" >&2
  else
    echo "  set NEON_DATABASE_URL_POOLED_PROD" >&2
  fi
  exit 1
fi

# Resolve the DIRECT (session-mode, unpooled) DB URL per-env for streaming RLS.
# Required: the container sets MARFA_DB_POOL_MODE=transaction, and the server
# fails closed at boot rather than reusing the pooled client for a session-level
# role switch. Fail here instead, where the operator can act on it.
if [[ "$ENV_NAME" == "staging" ]]; then
  DIRECT_DB_URL="${NEON_DATABASE_URL_STAGING:-${NEON_DATABASE_URL_MARFA:-}}"
else
  DIRECT_DB_URL="${NEON_DATABASE_URL_PROD:-}"
fi
if [[ -z "$DIRECT_DB_URL" ]]; then
  echo "error: no direct (unpooled) Neon URL resolved for $ENV_NAME" >&2
  if [[ "$ENV_NAME" == "staging" ]]; then
    echo "  set NEON_DATABASE_URL_STAGING (or legacy NEON_DATABASE_URL_MARFA)" >&2
  else
    echo "  set NEON_DATABASE_URL_PROD" >&2
  fi
  exit 1
fi

# Consumer-scoped name first, so a deployer with no knowledge of any
# particular operator's shell can run this. The suffixed name stays as a
# fallback only.
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_API_TOKEN_MARFA:-}}"
if [[ -z "$CF_TOKEN" ]]; then
  echo "error: no Cloudflare API token resolved" >&2
  echo "  set CLOUDFLARE_API_TOKEN to a token with Workers write on the target account" >&2
  exit 1
fi

# Resolve the PostHog ingestion token per-env so staging and prod telemetry land
# in their OWN PostHog projects. Prod falls back to the legacy shared name so
# existing operator shells keep working.
if [[ "$ENV_NAME" == "staging" ]]; then
  POSTHOG_TOKEN="${POSTHOG_PROJECT_KEY_STAGING:-}"
else
  POSTHOG_TOKEN="${POSTHOG_PROJECT_KEY_PROD:-${POSTHOG_PROJECT_KEY_MARFA:-}}"
fi
if [[ -z "$POSTHOG_TOKEN" ]]; then
  echo "error: no PostHog ingestion token resolved for $ENV_NAME" >&2
  if [[ "$ENV_NAME" == "staging" ]]; then
    echo "  set POSTHOG_PROJECT_KEY_STAGING (project 204959 ingestion token)" >&2
  else
    echo "  set POSTHOG_PROJECT_KEY_PROD (or legacy POSTHOG_PROJECT_KEY_MARFA)" >&2
  fi
  exit 1
fi

# API_KEY_SALT and MARFA_AUTH_SECRET are the two secrets here whose replacement
# is destructive and unrecoverable: a new salt invalidates every API key on the
# deployment, and a new auth secret signs out every session. Neither old value
# can be recovered afterwards, because Cloudflare does not read a secret back.
#
# So when the operator supplies no explicit value, the only safe reading of
# "init" is "fill the gap", never "replace what is already there". Generating
# unconditionally turns a re-run — the natural thing to do when adding one new
# secret to an existing Worker — into a total credential wipe, and the operator
# only finds out from a warning printed after the write has already happened.
EXISTING_SECRETS="$(wrangler secret list --name "$WORKER" 2>/dev/null || true)"
worker_has_secret() { grep -q "\"$1\"" <<<"$EXISTING_SECRETS"; }

ROTATE="${MARFA_ROTATE_SERVER_SECRETS:-}"
if [[ "$ROTATE" == "1" ]]; then
  echo "⚠ MARFA_ROTATE_SERVER_SECRETS=1 — replacing MARFA_AUTH_SECRET and API_KEY_SALT."
  echo "  Every API key on $WORKER stops working and every session is signed out."
fi

# resolve_stable <secret name> <explicit value> <outvar> — decide whether to
# set, keep, or generate. Echoes the decision; sets <outvar> to the value to
# write, or empty to leave the Worker's existing secret alone.
resolve_stable() {
  local name="$1" explicit="$2" outvar="$3"
  if [[ -n "$explicit" ]]; then
    printf -v "$outvar" '%s' "$explicit"
  elif worker_has_secret "$name" && [[ "$ROTATE" != "1" ]]; then
    echo "  – keep $name (already set on $WORKER; pass MARFA_ROTATE_SERVER_SECRETS=1 to replace)"
    printf -v "$outvar" '%s' ""
  else
    printf -v "$outvar" '%s' "$(openssl rand -hex 32)"
    GENERATED+=("$name")
  fi
}

GENERATED=()
resolve_stable MARFA_AUTH_SECRET "${MARFA_SERVER_AUTH_SECRET:-}" AUTH_SECRET
resolve_stable API_KEY_SALT "${MARFA_SERVER_API_KEY_SALT:-}" SALT

echo "→ Setting secrets on $WORKER"
put_secret DATABASE_URL "$POOLED_DB_URL"
put_secret MARFA_DATABASE_URL_DIRECT "$DIRECT_DB_URL"
# Empty here means "resolve_stable decided to keep the Worker's existing value",
# which is not the same as put_secret's "the source env var was unset".
if [[ -n "$AUTH_SECRET" ]]; then put_secret MARFA_AUTH_SECRET "$AUTH_SECRET"; fi
if [[ -n "$SALT" ]]; then put_secret API_KEY_SALT "$SALT"; fi
put_secret CLOUDFLARE_EMAIL_API_TOKEN "$CF_TOKEN"
put_secret OTEL_EXPORTER_OTLP_HEADERS "Authorization=Bearer ${POSTHOG_TOKEN}"

# Optional — reactive runs / schedule arming / R2 blobs.
if [[ "${MARFA_SET_QUEUES:-}" == "1" ]]; then
  put_secret CLOUDFLARE_QUEUES_API_TOKEN "$CF_TOKEN"
  put_secret CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS "${CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS:-}"
fi
put_secret MARFA_RUNTIME_BROKER_KEY "${MARFA_RUNTIME_BROKER_KEY:-}"
put_secret S3_ACCESS_KEY_ID "${R2_ACCESS_KEY_ID:-}"
put_secret S3_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY:-}"

if (( ${#GENERATED[@]} > 0 )); then
  echo ""
  echo "⚠ Generated secret(s) — persist these now; Cloudflare cannot read a secret"
  echo "  back, so an unrecorded value is unrecoverable:"
  for name in "${GENERATED[@]}"; do
    case "$name" in
      MARFA_AUTH_SECRET) echo "  MARFA_SERVER_AUTH_SECRET=$AUTH_SECRET" ;;
      API_KEY_SALT) echo "  MARFA_SERVER_API_KEY_SALT=$SALT" ;;
    esac
  done
fi

echo "→ Done. Re-run deploy-server-container.sh $ENV_NAME so the container restarts with these."
