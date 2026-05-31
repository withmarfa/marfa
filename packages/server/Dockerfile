# syntax=docker/dockerfile:1
#
# Marfa server — production container image for Cloudflare Containers (T-277).
#
# Build context is the MONOREPO ROOT (the server's workspace deps —
# @withmarfa/shared, @withmarfa/webhooks, @withmarfa/runtime-sdk — are built
# from source). Build from the repo root:
#
#   docker buildx build --platform linux/amd64 -f packages/server/Dockerfile .
#
# Cloudflare Containers run linux/amd64; the self-hosted CI runner is arm64,
# so the CI build cross-compiles via buildx + QEMU (see the deploy workflow).
#
# Strategy (validated): full workspace install + build, then `pnpm deploy
# --legacy --prod` prunes to a self-contained dir carrying only the runtime
# workspace deps. The server tsup-externalizes @withmarfa/runtime-sdk, which
# is value-imported via the statically-loaded local-runtime path, so it must
# be a production dependency (it is) — a bare --prod install would otherwise
# drop it and the container would crash at boot.

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# `...` builds the server plus its transitive workspace dependencies.
RUN pnpm --filter @withmarfa/server... build
# Prune to a self-contained production deploy at /app/out
# (dist + drizzle + a flattened node_modules; dev-only workspace deps dropped).
RUN pnpm --filter @withmarfa/server --legacy --prod deploy /app/out

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8600
# Deployed build identifier — read at startup, surfaced on GET / and /health.
ARG VERSION_SHA=dev
WORKDIR /app
COPY --from=build --chown=node:node /app/out ./
RUN printf '{"sha":"%s"}\n' "$VERSION_SHA" > version.json \
  # Make /app writable by the non-root user. Hosted uses R2 (BLOB_BACKEND=s3),
  # but the fs blob fallback (and any cwd-relative write) needs a writable dir.
  && mkdir -p data \
  && chown -R node:node /app
USER node
EXPOSE 8600
# Liveness probe. /health returns 200 (status ok|degraded); slim has no curl,
# so use Node's global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8600)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# The OpenTelemetry bootstrap MUST preload via --import so HTTP
# instrumentation patches node:http before the app's modules load.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
