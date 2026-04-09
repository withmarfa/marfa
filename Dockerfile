# ---------------------------------------------------------------------------
# Myme server — multi-stage Docker build
# Runs in Postgres mode with S3-compatible blob storage (MinIO)
# ---------------------------------------------------------------------------

# Stage 1: Install dependencies
FROM node:20-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @mymehq/server...

# Stage 2: Build
FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY tsconfig.base.json ./
RUN pnpm --filter @mymehq/shared run build && pnpm --filter @mymehq/server run build

# Stage 3: Production runtime
FROM node:20-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @mymehq/server... --prod

COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/server/dist/ packages/server/dist/
COPY --from=build /app/packages/server/drizzle/ packages/server/drizzle/

ENV NODE_ENV=production
EXPOSE 8600

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8600/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
