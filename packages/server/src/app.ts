import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { itemRoutes } from "./routes/items.js";
import { threadRoutes } from "./routes/threads.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { blobRoutes } from "./routes/blobs.js";
import { keyRoutes } from "./routes/keys.js";
import { importRoutes, exportRoutes } from "./routes/import-export.js";
import { authRoutes } from "./routes/oauth.js";
import { extensionRoutes } from "./routes/extensions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { metricsRoutes } from "./routes/metrics.js";
import { userAuthRoutes } from "./routes/users.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { mountGraphQL } from "./graphql/index.js";

export function createApp(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global error handler
  app.onError(errorHandler);

  // Structured logging (wraps entire request lifecycle)
  app.use("*", loggerMiddleware());

  // CORS
  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  }

  // Public routes (before auth) — mounted directly to avoid prefix matching issues
  const features = [
    "items",
    "threads",
    "search",
    "blobs",
    "types",
    "keys",
    "import",
    "export",
    "oauth",
    "extensions",
    "events",
    "webhooks",
    "type_crud",
    "metrics",
  ];
  if (config.enableGraphql) {
    features.push("graphql");
  }
  if (config.authMode === "hosted") {
    features.push("users");
  }
  app.get("/", (c) =>
    c.json({
      name: "myme",
      version: "0.1.0",
      features,
      cdn_base_url: config.cdnBaseUrl || null,
    }),
  );
  app.get("/health", (c) =>
    c.json({ status: "ok", auth_mode: config.authMode }),
  );

  // Rate limiting (before auth to protect all endpoints)
  // Only enabled when RATE_LIMIT_REQUESTS is explicitly configured
  if (process.env.RATE_LIMIT_REQUESTS) {
    app.use("*", rateLimitMiddleware());
  }

  // Auth middleware
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // GraphQL is disabled by default. Enable via ENABLE_GRAPHQL=true.
  if (config.enableGraphql) {
    mountGraphQL(app, storage);
  }

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/threads", threadRoutes(storage));
  app.route("/types", typeRoutes(storage));
  app.route("/search", searchRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/import", importRoutes(storage));
  app.route("/export", exportRoutes(storage));
  app.route("/auth", authRoutes(storage, config.apiKeySalt));
  if (config.authMode === "hosted" && storage.users && storage.tenants) {
    app.route("/auth", userAuthRoutes(storage, config.apiKeySalt));
  }
  app.route("/events", eventRoutes());
  app.route("/webhooks", webhookRoutes(storage));
  app.route("/metrics", metricsRoutes(storage));

  return app;
}
