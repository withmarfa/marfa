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
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { mountGraphQL } from "./graphql/index.js";

export function createApp(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global error handler
  app.onError(errorHandler);

  // CORS
  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  } else if (process.env.NODE_ENV !== "test") {
    console.warn(
      "CORS not configured — browser clients will be blocked. Set CORS_ORIGINS to enable.",
    );
  }

  // Public routes (before auth) — mounted directly to avoid prefix matching issues
  app.get("/", (c) =>
    c.json({
      name: "myme",
      version: "0.0.1",
      features: [
        "items",
        "threads",
        "search",
        "blobs",
        "types",
        "keys",
        "import",
        "export",
        "oauth",
        "graphql",
        "extensions",
      ],
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Rate limiting (before auth to protect all endpoints)
  // Only enabled when RATE_LIMIT_REQUESTS is explicitly configured
  if (process.env.RATE_LIMIT_REQUESTS) {
    app.use("*", rateLimitMiddleware());
  }

  // Auth middleware
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // GraphQL (after auth middleware, before REST routes)
  mountGraphQL(app, storage);

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/threads", threadRoutes(storage));
  app.route("/types", typeRoutes());
  app.route("/search", searchRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/import", importRoutes(storage));
  app.route("/export", exportRoutes(storage));
  app.route("/auth", authRoutes(storage, config.apiKeySalt));

  return app;
}
