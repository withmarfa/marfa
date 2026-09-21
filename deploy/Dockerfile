# syntax=docker/dockerfile:1
#
# The server with Litestream beside it. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t marfa-server .
#
# The build context is the whole repository because the server's workspace
# dependencies are built from source here. The runtime stage carries the
# pruned production install `pnpm deploy` makes, the Litestream binary and
# the sidecar's configuration; `Dockerfile.dockerignore` beside this file
# keeps installed modules, build output and local state out of the context.

ARG NODE_VERSION=24
ARG LITESTREAM_VERSION=0.5.17

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
# The commit this image was built from, which the server reads from
# `version.json` at boot and reports on `GET /`.
ARG VERSION_SHA=dev
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build --chown=node:node /out ./
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/entrypoint.sh /usr/local/bin/marfa-entrypoint
RUN printf '{"sha":"%s","deployed_at":"%s"}\n' "$VERSION_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.json \
  && chmod +x /usr/local/bin/marfa-entrypoint \
  && mkdir -p /data \
  && chown -R node:node /app /data
USER node
VOLUME /data
EXPOSE 8600
# `/health` answers 200 with a status of ok or degraded; slim carries no
# curl, so the probe is Node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8600)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/marfa-entrypoint"]
