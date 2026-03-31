import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { FilesystemBlobBackend } from "./storage/blob-backend.js";
import { healthRoutes } from "./routes/health.js";
import { itemRoutes } from "./routes/items.js";
import { threadRoutes } from "./routes/threads.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { blobRoutes } from "./routes/blobs.js";
import { keyRoutes } from "./routes/keys.js";
import { importRoutes, exportRoutes } from "./routes/import-export.js";

export function createApp(
  storage: Storage,
  blobBackend: FilesystemBlobBackend,
  config: AppConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global error handler
  app.onError(errorHandler);

  // CORS
  if (config.corsOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsOrigins }));
  }

  // Public routes (before auth)
  app.route("/", healthRoutes());

  // Auth middleware
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/threads", threadRoutes(storage));
  app.route("/types", typeRoutes());
  app.route("/search", searchRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/import", importRoutes(storage));
  app.route("/export", exportRoutes(storage));

  return app;
}
