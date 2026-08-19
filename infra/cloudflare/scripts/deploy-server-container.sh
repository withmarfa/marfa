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
#   - CLOUDFLARE_API_TOKEN     (token with Workers write on the target account)
#   - CLOUDFLARE_ACCOUNT_ID    (marfa account id)
#
# <ENV>_API_BASE_URL and <ENV>_CORS_ORIGINS live as repository Actions
# variables, so CI has them in scope and a local shell does not. The script
# resolves them itself via `gh` when the shell lacks them, and REFUSES TO
# DEPLOY if it cannot, rather than defaulting.
#
# That refusal is deliberate and was added after the guess shipped. The old
# fallbacks looked reasonable — a workers.dev host for the base URL, the API's
# own origin for the CORS list — and neither fails anything. They deploy a
# server whose OAuth issuer and cookie domain are wrong and whose CORS list
# admits nobody, and report success. The auth base URL is worse than the CORS
# list, because every signed-in surface breaks at once with no error anywhere
# that points at the deploy.
#
# So: nothing here is inferred. Export the values to override, or let the
# script read them. The rendered values are printed before the roll; read them
# rather than assuming, because a wrong one still looks like a healthy deploy.
#
# One thing the printout cannot tell you: the container reads `envVars` ONCE at
# launch, so changing them and redeploying the Worker does not move a running
# container. It keeps the old values until it next restarts. An environment on
# a short idle window cycles on its own soon enough not to notice; one held
# resident by a long window, by warm, or by steady traffic needs an image roll
# to force it.
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
#   - V_BLOB_BACKEND           (default "s3", the durable backend; "fs" also
#                               requires ALLOW_EPHEMERAL_BLOBS=1 because the
#                               container disk is wiped on scale-to-zero)
#   - SKIP_S3_CRED_CHECK       (set to 1 to bypass the s3 credential guard that
#                               otherwise blocks a BLOB_BACKEND=s3 deploy when the
#                               Worker lacks the S3 secrets)
#   - SKIP_DB_DIRECT_CHECK     (set to 1 to bypass the pre-flight that blocks a
#                               deploy when the Worker lacks MARFA_DATABASE_URL_DIRECT,
#                               which the container now refuses to boot without)
#   - S3_ENDPOINT              (R2 S3-API endpoint; default derives the standard-jurisdiction
#                               host — override for a jurisdiction-restricted bucket, e.g. EU)
#   - SERVER_SLEEP_AFTER       (container idle scale-to-zero timer; default "20m")
#   - V_CONTAINER_INSTANCE     (Durable Object instance name; a generation marker.
#                               Changing it abandons the pinned object for a fresh
#                               one, which is the only way to relocate a running
#                               deployment — see the placement block below)
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
# WHAT ROLLS WHAT, AND WHY THE ORDER IS ASYMMETRIC
#   The container receives its environment from the Worker's `envVars` map, read
#   once at container launch. So a change to `server-container/src/index.ts`
#   (adding a variable, changing a static value like MARFA_DB_POOL_MODE) only
#   takes effect when the WORKER is redeployed — running this script — and a
#   change to the server image only takes effect when a new image tag rolls.
#   The two failure modes are not symmetric:
#     - Old image + new Worker: safe. The container gets variables it ignores.
#     - New image + old Worker: NOT safe, and silent. The image expects config
#       the Worker never forwards, so it takes its "unset" branch and reports
#       nothing wrong. That is exactly how MARFA_DATABASE_URL_DIRECT stayed
#       inert for the life of the feature it was added for.
#   Deploy the Worker whenever `envVars` changes, even if the image has not.
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
#   SHA="$(git rev-parse --short HEAD)"
#   TAG="<env>-$SHA"                            # e.g. staging-1a2b3c4
#   docker buildx build --platform linux/amd64 -f packages/server/Dockerfile \
#     --build-arg VERSION_SHA="$SHA" -t "marfa-server:$TAG" --load .
#   wrangler containers push "marfa-server:$TAG"
# VERSION_SHA is not optional in practice. The Dockerfile defaults it to "dev",
# so a build without it deploys a server that reports {"sha":"dev"} on /health —
# leaving no way to tell which commit an environment is actually running, which
# is the one question a deploy check exists to answer.
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
# Memory and disk bill on PROVISIONED capacity; only vCPU bills on actual use.
# Measured against the real image with a live database: idle 175 MiB, and
# 188 MiB peak under nineteen concurrent reads plus a full export. The working
# set does not move. So memory is ~93% of the container bill and buys nothing
# above ~200 MiB, while vCPU is ~2% of it.
#
# Custom instance types cannot express the right shape: Cloudflare requires
# >= 1 vCPU and >= 3 GiB per vCPU for a custom type, so "keep the CPU, cut the
# memory" is not purchasable. The presets are the only lever, and they bundle
# both dimensions:
#
#   basic       1/4 vCPU   1 GiB   4 GB
#   standard-1  1/2 vCPU   4 GiB   8 GB
#
# Dropping to basic quarters the memory bill and halves the vCPU allocation.
# Measured cost of that halving on this image: app startup 6s -> 15s, read p50
# 250ms -> 400ms, and latency under concurrent writes stops being steady enough
# to measure against. Whether that trade is worth taking differs per
# environment — an environment nobody watches should take it, one that hosts
# timing-sensitive verification should not — so it is set in the per-env blocks
# below rather than shared here. A shared assignment would run first and
# silently win over their `:-` defaults.
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
# Hosted blob storage is durable object storage. The container filesystem is
# wiped on every scale-to-zero cycle and on every redeploy, so an fs deploy on
# a hosted environment silently discards every blob uploaded since the last
# roll. The backend therefore defaults to s3 here, and an ephemeral deploy has
# to be asked for by name: set both V_BLOB_BACKEND=fs and
# ALLOW_EPHEMERAL_BLOBS=1, or the deploy refuses. The credential guard below
# still vets the s3 path before rollout, so the safe default cannot ship
# broken blob writes either.
export V_BLOB_BACKEND="${V_BLOB_BACKEND:-s3}"
if [[ "$V_BLOB_BACKEND" != "s3" && "${ALLOW_EPHEMERAL_BLOBS:-}" != "1" ]]; then
  echo "error: V_BLOB_BACKEND=$V_BLOB_BACKEND stores blobs on the container's ephemeral disk," >&2
  echo "which loses them on the next scale-to-zero cycle or redeploy." >&2
  echo "If an ephemeral validation deploy is intended, set ALLOW_EPHEMERAL_BLOBS=1 as well." >&2
  exit 1
fi

# Resolve a deploy-critical value that lives as a repository Actions variable.
# CI has these in scope and a local shell does not, so both used to fall back to
# something plausible: the auth base URL to a workers.dev host, and the CORS
# allow-list to whatever the auth base URL resolved to. Both deploy cleanly and
# report nothing wrong. The auth base URL drives cookie domain and the OAuth
# issuer, so a wrong one breaks every signed-in surface; a truncated CORS list
# breaks one app's reads against the API and nothing else notices. A deploy that
# silently misconfigures auth is worse than a deploy that refuses to run.
#
# Sets the named variable in place rather than echoing, so the `exit` below
# leaves the script instead of a command-substitution subshell, which would
# assign an empty value and carry on.
resolve_repo_var() {
  local name="$1"
  [[ -n "${!name:-}" ]] && return 0
  local fetched
  fetched="$(gh variable list --repo withmarfa/marfa --json name,value \
    --jq ".[]|select(.name==\"${name}\")|.value" 2>/dev/null || true)"
  if [[ -z "$fetched" ]]; then
    echo "error: ${name} is unset and could not be read from the repository." >&2
    echo "  It decides the auth base URL and the CORS allow-list. Guessing it" >&2
    echo "  produces a deploy that succeeds and a server that cannot sign anyone" >&2
    echo "  in, so this refuses rather than defaulting." >&2
    echo "  Export it, or authenticate gh so it can be resolved." >&2
    exit 1
  fi
  printf -v "$name" '%s' "$fetched"
  export "${name?}"
  echo "resolved ${name} from the repository (not set in this shell)"
}

if [[ "$ENV_NAME" == "staging" ]]; then
  export SERVER_WORKER_NAME="marfa-server-staging"
  # See the placement block below. Staging's Neon project and R2 bucket are in
  # Europe, so the container belongs there too.
  export SERVER_REGION="WEUR"
  # Closed, matching prod. An enabled subdomain is a second hostname for the
  # same origin, so anything attached to the named one — WAF rules, zone rate
  # limiting, an access policy — is bypassed by addressing the Worker directly,
  # and CORS origin lists and cookie domains stop describing the whole surface.
  # Staging holds real accounts and real tokens, which makes "it is only
  # staging" a reason this ranked lower, not a reason it was acceptable.
  # Override per-invocation if a throwaway Worker genuinely needs a URL before
  # its route exists.
  export SERVER_WORKERS_DEV="${SERVER_WORKERS_DEV:-false}"
  export SERVER_ROUTES="[]"
  # Tag staging telemetry so its logs are distinguishable from prod's in their
  # separate PostHog projects (the container's NODE_ENV is "production" on both,
  # so the OTel bootstrap can't derive this).
  export V_OTEL_ENVIRONMENT="staging"
  # Long idle window, deliberately, while heavy delivery runs against staging.
  # Staging is driven in bursts — an agent session, a verification battery, a
  # conformance sweep — separated by a few minutes of thinking time. At a
  # two-minute window it was resident about fifteen percent of the day, so most
  # requests opened by paying a cold start. An hour holds the instance across a
  # working session while still scaling to zero overnight and on quiet days,
  # which is where the saving came from in the first place. Costs well under a
  # dollar a month over the shorter window. Warm (below) would be an order of
  # magnitude more and buys nothing beyond this during hours nobody works.
  # Shorten this again when staging stops carrying daily delivery.
  export SERVER_SLEEP_AFTER="${SERVER_SLEEP_AFTER:-1h}"
  # Sized for verification rather than for idling. The smaller preset was right
  # while staging only had to answer requests, and is wrong now that
  # timing-sensitive work runs here. Measured against the real image with a live
  # database: read p50 0.40s against 0.25s, app startup 15s against 6s, and a
  # quarter vCPU leaves latency under concurrent writes variable enough that a
  # test measuring it cannot separate a regression from a busy container. That
  # ambiguity costs more than the instance does — it has already stalled a
  # concurrency verification that had to be abandoned mid-run. Sizing up also
  # retires the standing caveat on the smaller shape, whose five-times headroom
  # over the measured 188 MiB peak had never been tested against the
  # `load:extreme` profile and its twelve thousand items.
  export SERVER_INSTANCE_TYPE="${SERVER_INSTANCE_TYPE:-standard-1}"
  # Deliberate warm policy — OFF by default (opt-in). Warm keeps the single
  # instance resident so the first request after an idle gap never pays a cold
  # start (staging backs the Tickets responsiveness surface). COST: an always-on
  # container bills continuously — provisioned memory + disk for the whole
  # resident window plus its managing Durable Object (~$12.50/mo floor), on the
  # order of tens of dollars/month per instance. Off = scale-to-zero on the idle
  # timer above, so an untouched env costs ~nothing. Reach for a longer idle
  # window before reaching for this: it buys the same experience during the
  # hours anyone is working, and stops billing when they are not.
  export V_CONTAINER_WARM="${V_CONTAINER_WARM:-false}"
  export V_RUNTIME_CONTROL_URL="https://runtime-staging.marfa.so"
  export V_S3_BUCKET="marfa-blobs-staging"
  # workers.dev URL drives auth cookies. Defaults to the conventional host;
  # override STAGING_WORKERS_SUBDOMAIN if the account subdomain differs.
  SUB="${STAGING_WORKERS_SUBDOMAIN:-}"
  if [[ -n "$SUB" ]]; then
    export V_AUTH_BASE_URL="https://marfa-server-staging.${SUB}.workers.dev"
  else
    resolve_repo_var STAGING_API_BASE_URL
    export V_AUTH_BASE_URL="$STAGING_API_BASE_URL"
  fi
  resolve_repo_var STAGING_CORS_ORIGINS
  export V_CORS_ORIGINS="$STAGING_CORS_ORIGINS"
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-staging-${GIT_SHA}}"
else
  export SERVER_WORKER_NAME="marfa-server"
  # See the placement block below. This is the environment the setting was
  # added for: production's container ran in San Jose while its database and
  # bucket sat in Europe, which cost roughly 135ms on every one of the many
  # sequential round trips a request makes.
  export SERVER_REGION="WEUR"
  export SERVER_WORKERS_DEV="false"
  export SERVER_ROUTES='[{"pattern":"api.marfa.so","custom_domain":true}]'
  export V_OTEL_ENVIRONMENT="production"
  # Sized like staging, and for the same reason. The pre-launch premise for
  # the smaller preset — production has no real traffic, so nobody pays its
  # latency floor — no longer holds: integration backfills and platform
  # testing now write to production in bursts, and on `basic` those writes
  # ran slow enough to be mistaken for a platform defect. Measured warm and
  # like-for-like (same Neon tier): database health probes 354-619ms on
  # `basic` against 54-85ms on `standard-1` — a larger gap than the preset's
  # memory arithmetic predicts, so treat `basic` as unfit for write-heavy
  # use, not merely slower. Reverting to the pre-launch cost posture is this
  # line plus the idle window below.
  export SERVER_INSTANCE_TYPE="${SERVER_INSTANCE_TYPE:-standard-1}"
  # Staging parity, same reasoning as staging's window: production is driven
  # in bursts separated by minutes of thinking time, and a short window made
  # requests after each gap open on a cold start. COST: scheduled health
  # probes land often enough that an hour-long window holds the instance
  # resident most of the day — close to the warm floor (provisioned memory +
  # disk + managing Durable Object) without setting V_CONTAINER_WARM. Tune
  # this down first if production spend needs cutting.
  export SERVER_SLEEP_AFTER="${SERVER_SLEEP_AFTER:-1h}"
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
  # Resolved rather than defaulted. The old fallback was the API's own origin,
  # which is not a cross-origin caller at all, so it dropped every real one:
  # a local prod deploy silently cut `app.marfa.so` off from the API and the
  # deploy still reported success.
  resolve_repo_var PROD_CORS_ORIGINS
  export V_CORS_ORIGINS="$PROD_CORS_ORIGINS"
  export SERVER_IMAGE_TAG="${SERVER_IMAGE_TAG:-prod-${GIT_SHA}}"
fi

# PLACEMENT — where the container physically runs.
#
# Derived here rather than set twice, because the two mechanisms below have to
# agree and a mismatch is invisible until someone measures latency:
#
#   - The Durable Object location hint (lowercase, e.g. "weur") decides where
#     the object that manages the container is CREATED. It is read only on the
#     very first call for a given instance name and is a suggestion, not a
#     guarantee. The container is then scheduled next to its object.
#   - The container application constraint (uppercase, e.g. ["WEUR"]) is a hard
#     limit on where the CONTAINER may be scheduled.
#
# The two enums are identical apart from case, so one per-env SERVER_REGION
# renders both and they cannot drift.
#
# V_CONTAINER_INSTANCE is a generation marker, not a name anyone reads. A
# Durable Object is pinned to the region it was first instantiated in and never
# moves, so changing this string is the ONLY way to relocate an existing
# deployment — it abandons the pinned object for a fresh one created under the
# hint above. It is shared rather than per-env deliberately: the environments
# being byte-identical in every deploy-controlled setting is what made the
# original divergence diagnosable.
#
# Bumping it costs one container replacement. The object's only persisted state
# is the key recording which image is running, so the next request re-reads it
# and rolls, exactly as it would after any other cold start. Bump it if an
# environment is ever found running outside SERVER_REGION.
export V_CONTAINER_INSTANCE="${V_CONTAINER_INSTANCE:-marfa-server-1}"
export V_CONTAINER_LOCATION_HINT="$(printf '%s' "$SERVER_REGION" | tr '[:upper:]' '[:lower:]')"
export SERVER_CONSTRAINT_REGIONS="[\"${SERVER_REGION}\"]"

# Boot guard: the container declares MARFA_DB_POOL_MODE=transaction, so the
# server refuses to start without MARFA_DATABASE_URL_DIRECT. That refusal is
# deliberate — streaming RLS sets a session-level role, which strands on a
# shared backend over the pooled endpoint DATABASE_URL points at — but a
# container that will not boot surfaces as a generic "Failed to start container"
# 500 after the roll. Check before, where the message can name the fix. Same
# live-secret-list approach as the S3 guard below. Skip with
# SKIP_DB_DIRECT_CHECK=1.
if [[ "${SKIP_DB_DIRECT_CHECK:-}" != "1" ]]; then
  echo "→ Verifying MARFA_DATABASE_URL_DIRECT is set on $SERVER_WORKER_NAME"
  if DB_SECRET_LIST="$(wrangler secret list --name "$SERVER_WORKER_NAME" 2>/dev/null)"; then
    if grep -q '"MARFA_DATABASE_URL_DIRECT"' <<<"$DB_SECRET_LIST"; then
      echo "  ✓ MARFA_DATABASE_URL_DIRECT present"
    else
      echo "error: the Worker is missing the MARFA_DATABASE_URL_DIRECT secret." >&2
      echo "  The container sets MARFA_DB_POOL_MODE=transaction, so the server" >&2
      echo "  will refuse to boot without it and the roll will fail." >&2
      if [[ "$ENV_NAME" == "staging" ]]; then
        echo "  Fix: set NEON_DATABASE_URL_STAGING in your shell, then run:" >&2
      else
        echo "  Fix: set NEON_DATABASE_URL_PROD in your shell, then run:" >&2
      fi
      echo "    ./infra/cloudflare/scripts/init-server-container-secrets.sh $ENV_NAME" >&2
      exit 1
    fi
  else
    # A first-ever deploy has no Worker to list secrets on yet. Refusing here
    # would block a legitimate bootstrap on a check that cannot run, so say so
    # and continue rather than assert something unverified.
    echo "  ⚠ could not read the secret list (new Worker?) — skipping this check" >&2
  fi
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

TEMPLATE_VARS='${SERVER_WORKER_NAME} ${CLOUDFLARE_ACCOUNT_ID} ${SERVER_WORKERS_DEV} ${SERVER_ROUTES} ${SERVER_IMAGE} ${SERVER_INSTANCE_TYPE} ${SERVER_MAX_INSTANCES} ${SERVER_CONSTRAINT_REGIONS} ${SERVER_SLEEP_AFTER} ${V_CONTAINER_INSTANCE} ${V_CONTAINER_LOCATION_HINT} ${V_CONTAINER_WARM} ${V_BLOB_BACKEND} ${V_AUTH_BASE_URL} ${V_CORS_ORIGINS} ${V_RUNTIME_CONTROL_URL} ${V_INTEGRATION_RUNTIME} ${V_EMAIL_FROM} ${V_S3_BUCKET} ${V_S3_ENDPOINT} ${V_OTEL_LOGS_ENDPOINT} ${V_OTEL_ENVIRONMENT}'

echo "→ Rendering server-container/wrangler.jsonc for $ENV_NAME"
envsubst "$TEMPLATE_VARS" < "$SOURCE_JSONC" > "$RENDERED_JSONC"

UNRESOLVED="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$RENDERED_JSONC" || true)"
if [[ -n "$UNRESOLVED" ]]; then
  echo "error: rendered config has unresolved tokens:" >&2
  echo "$UNRESOLVED" | sort -u | sed 's/^/  /' >&2
  exit 1
fi

echo "→ Rendered config preview:"
grep -E '"name"|"image"|"instance_type"|"max_instances"|"constraints"|workers_dev|routes|BLOB_BACKEND|MARFA_AUTH_BASE_URL|MARFA_INTEGRATION_RUNTIME|MARFA_CONTAINER_INSTANCE|MARFA_CONTAINER_LOCATION_HINT' "$RENDERED_JSONC" | sed 's/^/  /'

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
