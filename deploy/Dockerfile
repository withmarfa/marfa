# syntax=docker/dockerfile:1
#
# The server with Litestream beside it. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t marfa-server .
#
# A release is published from this file as `ghcr.io/withmarfa/marfa-server`,
# built by `.github/workflows/release.yml` with `VERSION_RELEASE` set.
#
# The build context is the whole repository because the server's workspace
# dependencies are built from source here. The runtime stage carries the
# pruned production install `pnpm deploy` makes, the Litestream binary and
# the sidecar's configuration; `Dockerfile.dockerignore` beside this file
# keeps installed modules, build output and local state out of the context.

ARG NODE_VERSION=24
ARG LITESTREAM_VERSION=0.5.17

FROM rust:1-slim-bookworm AS cli-build
WORKDIR /repo
COPY core/ ./core/
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo fetch --locked --manifest-path core/Cargo.toml
# A release build stamps its version into the workspace the way
# `scripts/release/stamp-version.sh` does, so the packaged `marfa` reports the
# release in `--version` and in its telemetry rather than the placeholder
# `0.0.0`. The lock file follows the manifest, offline, from the crates
# fetched above.
ARG VERSION_RELEASE
RUN if [ -n "$VERSION_RELEASE" ]; then \
      printf '%s' "$VERSION_RELEASE" | grep -Eq '^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$' \
        || { echo "VERSION_RELEASE must be major.minor.patch" >&2; exit 1; }; \
      sed -i "0,/^version = \"0.0.0\"/s//version = \"$VERSION_RELEASE\"/" core/Cargo.toml; \
      (cd core && cargo update --workspace --offline --quiet); \
    fi
RUN cargo build --manifest-path core/Cargo.toml --locked --release -p marfa-cli

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# `...` builds the server and every workspace package it depends on.
RUN pnpm --filter "@withmarfa/server..." build
# A self-contained production install: dist, the runtime dependencies, the
# workspace dependencies copied in rather than linked.
RUN pnpm --filter @withmarfa/server --legacy deploy --prod /out

FROM litestream/litestream:${LITESTREAM_VERSION} AS litestream

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8600
# Where the volume is mounted. Both names are read by the server and by
# `entrypoint.sh`, which restores the database to the first when the volume
# holds none.
ENV SQLITE_PATH=/data/marfa.db
ENV BLOB_PATH=/data/blobs
ENV MARFA_CONTROL_SOCKET=/data/control/marfa.sock
# The commit this image was built from, which the server reads from
# `version.json` at boot and reports on `GET /` as `version`, in `/health` and
# as the version of every span it exports. `VERSION_RELEASE`, given only by a
# release build, is the release's version, which the server reports on `GET /`
# as `release` and which the packaged `marfa` reports as its own; a build
# without it names no release.
ARG VERSION_SHA
ARG VERSION_RELEASE
ARG RAILWAY_GIT_COMMIT_SHA
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends acl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=cli-build /repo/core/target/release/marfa /usr/local/bin/marfa
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build --chown=node:node /out ./
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/entrypoint.sh /usr/local/bin/marfa-entrypoint
RUN printf '{"sha":"%s","deployed_at":"%s"%s}\n' "${VERSION_SHA:-${RAILWAY_GIT_COMMIT_SHA:-dev}}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${VERSION_RELEASE:+,\"release\":\"$VERSION_RELEASE\"}" > version.json \
  && chmod +x /usr/local/bin/marfa-entrypoint \
  && mkdir -p /data \
  && chown -R node:node /app /data
USER node
EXPOSE 8600
# `/health` answers 200 with a status of ok or degraded and 503 when a
# component is down; slim carries no curl, so the probe is Node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8600)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/marfa-entrypoint"]
