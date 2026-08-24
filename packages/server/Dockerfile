# syntax=docker/dockerfile:1
#
# Marfa server production container image.
#
# Build context is the MONOREPO ROOT (the server's workspace deps —
# @withmarfa/shared, @withmarfa/webhooks, @withmarfa/runtime-sdk — are built
# from source). Build from the repo root:
#
#   docker buildx build --platform linux/amd64 -f packages/server/Dockerfile .
#
# The droplets this runs on are linux/amd64. Both the deploy and the CI
# image-build job build it natively on a hosted amd64 runner, with no QEMU.
# On an arm64 host, such as a local Apple-Silicon machine, the same buildx
# command cross-compiles under emulation: slower, and the image is
# identical.
#
# Strategy (validated): full workspace install + build, then `pnpm deploy
# --legacy --prod` prunes to a self-contained dir carrying only the runtime
# workspace deps. The server tsup-externalizes @withmarfa/runtime-sdk, which
# is value-imported via the statically-loaded local-runtime path, so it must
# be a production dependency (it is) — a bare --prod install would otherwise
# drop it and the container would crash at boot.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# `...` builds the server plus its transitive workspace dependencies.
#
# The heap ceiling is load-bearing rather than cautious. tsup generates
# declarations in a worker thread, and that worker inherits Node's default
# old-space size, which is derived from the container's reported memory and
# lands well below what the server's type surface now needs. It died with
# ERR_WORKER_OUT_OF_MEMORY the first time three ordinary pull requests
# landed between two deploys, when nothing built this image before a deploy
# did and the failure therefore arrived as a broken deploy on a green
# `main`. CI builds it on merges now, so the next thing this build does
# differently is a red `main` rather than a blocked release. Raise the
# ceiling deliberately here, where the build actually runs.
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @withmarfa/server... build
# Build the integration entries this image installs, and stage their dist
# trees. What it installs is declared in installed-integrations.txt rather
# than being whatever the directory happens to hold, so a declared name
# that is not there fails the build and a directory nobody declared is not
# shipped. Nothing in either step needs the directory to exist: a
# declaration reading `none` leaves the filter matching no packages and the
# loop running no times, and the image ships an empty integrations root.
#
# The image must carry integrations/<name>/dist/local.js: the loader's
# default root resolves relative to the monorepo, which does not exist in
# a packaged image, so without these files the local substrate boots with
# an empty registration list, silently. Only dist/ is staged, no
# per-integration node_modules — each entry bundles its whole dependency
# graph except @withmarfa/runtime-sdk and @withmarfa/shared, and those two
# must resolve upward to the server's copies in /app/node_modules because
# both carry module-singleton state. Staging node_modules alongside an
# entry would shadow that resolution and break handler registration
# invisibly.
#
# A declared integration without a src/local.ts still ships a manifest, and
# the catalog reconcile at boot needs it: the catalog describes what is
# installable, which is a larger set than what dispatches. The sync
# integration is the standing case, a client whose agent lives outside
# the server process. Its dist/ is staged so the catalog can carry a
# current manifest for it, and the runtime loader still skips it because
# there is no local.js to dispatch into.
#
# This build runs before the deploy prune below: `pnpm deploy` rewrites
# the workspace's modules state, and any later `pnpm run` then fails the
# verify-deps-before-run guard.
RUN pnpm --filter "@withmarfa/integration-*" run build
# The parser's output is captured into a variable rather than expanded
# inline. `set -e` does not reach a command substitution performed while
# expanding a `for` word list, and a loop whose body never runs exits 0, so
# the inline form turns every declaration error into a green build stage
# that staged nothing. The verification later in the build would still
# catch it, but the first and clearest report of the fault would come from
# a step that had just claimed to succeed.
RUN set -euf; \
    mkdir -p /integrations-staged; \
    names="$(node packages/server/scripts/read-installed-integrations.mjs packages/server/installed-integrations.txt)"; \
    for name in $names; do \
      dir="integrations/$name"; \
      if [ ! -d "$dir" ]; then \
        echo "ERROR: $name is declared installed but $dir is not present" >&2; \
        exit 1; \
      fi; \
      if [ -f "$dir/src/local.ts" ] && [ ! -f "$dir/dist/local.js" ]; then \
        echo "ERROR: $name has src/local.ts but built no dist/local.js" >&2; \
        exit 1; \
      fi; \
      if [ ! -f "$dir/dist/local.js" ] && [ ! -f "$dir/dist/manifest.js" ]; then \
        echo "ERROR: $name built neither dist/local.js nor dist/manifest.js" >&2; \
        exit 1; \
      fi; \
      mkdir -p "/integrations-staged/$name"; \
      cp -R "$dir/dist" "/integrations-staged/$name/dist"; \
      echo "staged $name"; \
    done
# The scaffold is not installed, so it is staged outside the integrations
# root as the fixture the in-image verification dispatches through. It is
# built exactly the way a real integration is, which is what makes it a
# usable proof that the runtime kit resolves to a single copy; a fixture
# built any other way would prove something else. The runtime stage deletes
# it once the verification has passed.
RUN set -eu; \
    mkdir -p /verify-fixtures; \
    if [ -f integrations/_template/dist/local.js ]; then \
      mkdir -p /verify-fixtures/_template; \
      cp -R integrations/_template/dist /verify-fixtures/_template/dist; \
    fi
# Prune to a self-contained production deploy at /app/out
# (dist + drizzle + a flattened node_modules; dev-only workspace deps dropped).
# Last of the pnpm steps deliberately; see the note above the integration build.
RUN pnpm --filter @withmarfa/server --legacy --prod deploy /app/out

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8600
# Deployed build identifier — read at startup, surfaced on GET / and /health.
ARG VERSION_SHA=dev
# Re-export the build arg as an env var so the OTel bootstrap
# (instrumentation.ts) can stamp it onto the `service.version` resource
# attribute — a bare ARG is build-scoped and invisible to the running process.
ENV MARFA_VERSION_SHA=${VERSION_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /app/out ./
# The installed integrations for the local substrate, dist-only trees (see
# the build-stage note on why node_modules must not ride along), and beside
# them the declaration of what should be there, so the image carries a
# record of its own integration set.
COPY --from=build --chown=node:node /integrations-staged ./integrations
ENV MARFA_INTEGRATIONS_ROOT=/app/integrations
COPY --from=build --chown=node:node /repo/packages/server/installed-integrations.txt ./installed-integrations.txt
COPY --from=build --chown=node:node /verify-fixtures ./verify-fixtures
COPY --from=build --chown=node:node /repo/packages/server/scripts/verify-image-integrations.mjs ./verify-image-integrations.mjs
COPY --from=build --chown=node:node /repo/packages/server/scripts/read-installed-integrations.mjs ./read-installed-integrations.mjs
RUN printf '{"sha":"%s"}\n' "$VERSION_SHA" > version.json \
  # Make /app writable by the non-root user. Hosted uses R2 (BLOB_BACKEND=s3),
  # but the fs blob fallback (and any cwd-relative write) needs a writable dir.
  && mkdir -p data \
  && chown -R node:node /app
USER node
# An image carrying integrations other than the ones it declares, or in a
# shape it did not declare, or whose entries cannot load, or whose module
# resolution duplicates the runtime-sdk singleton, fails to build here
# rather than booting a wrong substrate in production.
#
# The dispatch fixture is removed in the same step, so nothing running in
# the container can mistake it for an installed integration. It is a
# whiteout rather than an erasure: the bytes still sit in the layer the COPY
# above created and are visible to anyone reading the image. Nothing about
# it is secret, so that is a size question rather than a safety one.
RUN node verify-image-integrations.mjs && rm -rf /app/verify-fixtures
EXPOSE 8600
# Liveness probe. /health returns 200 (status ok|degraded); slim has no curl,
# so use Node's global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8600)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# The OpenTelemetry bootstrap MUST preload via --import so HTTP
# instrumentation patches node:http before the app's modules load.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
