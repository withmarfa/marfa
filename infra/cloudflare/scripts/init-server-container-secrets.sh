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
# secrets file first). Secret slots use consumer-scoped names; the source env
# vars carry the *_MARFA / *_STAGING / *_PROD developer suffix.
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
# run on the transaction-mode pooled endpoint, where the role can strand on a
# shared backend and leak into a later write. Resolved per-env; OPTIONAL (the
# app falls back to the pooled client if unset, with the role-leak risk):
#
#   MARFA_DATABASE_URL_DIRECT  staging  <- NEON_DATABASE_URL_STAGING || NEON_DATABASE_URL_MARFA
#   MARFA_DATABASE_URL_DIRECT  prod     <- NEON_DATABASE_URL_PROD
#
#   MARFA_AUTH_SECRET           <- MARFA_SERVER_AUTH_SECRET        (stable; generated if unset)
#   API_KEY_SALT                <- MARFA_SERVER_API_KEY_SALT       (stable; generated if unset)
#   CLOUDFLARE_EMAIL_API_TOKEN  <- CLOUDFLARE_API_TOKEN_MARFA
#   OTEL_EXPORTER_OTLP_HEADERS  <- "Authorization=Bearer <per-env PostHog token>"
#     staging <- POSTHOG_PROJECT_KEY_STAGING
#     prod    <- POSTHOG_PROJECT_KEY_PROD || POSTHOG_PROJECT_KEY_MARFA (legacy)
#     (per-env so staging and prod telemetry land in separate PostHog projects)
# Optional (set only when the source var is present):
#   CLOUDFLARE_QUEUES_API_TOKEN <- CLOUDFLARE_API_TOKEN_MARFA      (only if MARFA_SET_QUEUES=1)
#   CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS <- CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS
#   MARFA_RUNTIME_BROKER_KEY    <- MARFA_RUNTIME_BROKER_KEY
#   S3_ACCESS_KEY_ID            <- R2_ACCESS_KEY_ID                (R2 S3-API creds)
#   S3_SECRET_ACCESS_KEY        <- R2_SECRET_ACCESS_KEY
#
# Generated auth secret/salt are PRINTED once — persist them (e.g. into the
# per-machine secrets file as MARFA_SERVER_AUTH_SECRET / MARFA_SERVER_API_KEY_SALT)
# so re-runs don't rotate them (rotating API_KEY_SALT invalidates every key).

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
# Optional: if unset, the app falls back to the pooled client (the role-switch
# can then strand on the pooler — only safe off a transaction-mode pooler).
if [[ "$ENV_NAME" == "staging" ]]; then
  DIRECT_DB_URL="${NEON_DATABASE_URL_STAGING:-${NEON_DATABASE_URL_MARFA:-}}"
else
  DIRECT_DB_URL="${NEON_DATABASE_URL_PROD:-}"
fi

: "${CLOUDFLARE_API_TOKEN_MARFA:?set CLOUDFLARE_API_TOKEN_MARFA}"

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

AUTH_SECRET="${MARFA_SERVER_AUTH_SECRET:-}"
SALT="${MARFA_SERVER_API_KEY_SALT:-}"
if [[ -z "$AUTH_SECRET" ]]; then AUTH_SECRET="$(openssl rand -hex 32)"; GEN_AUTH=1; fi
if [[ -z "$SALT" ]]; then SALT="$(openssl rand -hex 32)"; GEN_SALT=1; fi

echo "→ Setting secrets on $WORKER"
put_secret DATABASE_URL "$POOLED_DB_URL"
put_secret MARFA_DATABASE_URL_DIRECT "$DIRECT_DB_URL"
put_secret MARFA_AUTH_SECRET "$AUTH_SECRET"
put_secret API_KEY_SALT "$SALT"
put_secret CLOUDFLARE_EMAIL_API_TOKEN "$CLOUDFLARE_API_TOKEN_MARFA"
put_secret OTEL_EXPORTER_OTLP_HEADERS "Authorization=Bearer ${POSTHOG_TOKEN}"

# Optional — reactive runs / schedule arming / R2 blobs.
if [[ "${MARFA_SET_QUEUES:-}" == "1" ]]; then
  put_secret CLOUDFLARE_QUEUES_API_TOKEN "$CLOUDFLARE_API_TOKEN_MARFA"
  put_secret CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS "${CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS:-}"
fi
put_secret MARFA_RUNTIME_BROKER_KEY "${MARFA_RUNTIME_BROKER_KEY:-}"
put_secret S3_ACCESS_KEY_ID "${R2_ACCESS_KEY_ID:-}"
put_secret S3_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY:-}"

if [[ "${GEN_AUTH:-}" == "1" || "${GEN_SALT:-}" == "1" ]]; then
  echo ""
  echo "⚠ Generated secret(s) — persist these so re-runs don't rotate them:"
  [[ "${GEN_AUTH:-}" == "1" ]] && echo "  MARFA_SERVER_AUTH_SECRET=$AUTH_SECRET"
  [[ "${GEN_SALT:-}" == "1" ]] && echo "  MARFA_SERVER_API_KEY_SALT=$SALT"
  echo "(rotating API_KEY_SALT invalidates every API key.)"
fi

echo "→ Done. Re-run deploy-server-container.sh $ENV_NAME so the container restarts with these."
