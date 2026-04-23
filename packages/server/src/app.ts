import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { itemRoutes } from "./routes/items.js";
import { bulkRoutes } from "./routes/bulk.js";
import { edgeRoutes, itemEdgeListingRoutes } from "./routes/edges.js";
import { edgeTypeRoutes } from "./routes/edge-types.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { metadataRoutes } from "./routes/metadata.js";
import { blobRoutes } from "./routes/blobs.js";
import { keyRoutes } from "./routes/keys.js";
import { exportRoutes } from "./routes/export.js";
import { adminArchiveRoutes } from "./routes/admin-archive.js";
import { authRoutes } from "./routes/oauth.js";
import { extensionRoutes } from "./routes/extensions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { auditRoutes } from "./routes/audit.js";
import { metricsRoutes } from "./routes/metrics.js";
import { userAuthRoutes } from "./routes/users.js";
import { tenantRoutes } from "./routes/tenants.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { healthRoutes } from "./routes/health.js";
export function createApp(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
) {
  const app = new OpenAPIHono<AppEnv>();

  // Global error handler
  app.onError(createErrorHandler({ errorWebhookUrl: config.errorWebhookUrl }));

  // Structured logging (wraps entire request lifecycle)
  app.use("*", loggerMiddleware());

  // CORS — explicit origins from config, plus any localhost/127.0.0.1 origin automatically
  if (config.corsOrigins.length > 0) {
    app.use(
      "*",
      cors({
        origin: (origin) => {
          if (!origin) return config.corsOrigins[0];
          if (config.corsOrigins.includes(origin)) return origin;
          try {
            const url = new URL(origin);
            if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
              return origin;
            }
          } catch {
            // invalid origin, ignore
          }
          return config.corsOrigins[0];
        },
      }),
    );
  }

  // Security headers
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: config.enableHsts
        ? "max-age=63072000; includeSubDomains"
        : false,
      xFrameOptions: "DENY",
      xXssProtection: "1",
    }),
  );

  // Public routes (before auth) — mounted directly to avoid prefix matching issues
  const features = [
    "items",
    "search",
    "blobs",
    "types",
    "keys",
    "bulk",
    "export",
    "oauth",
    "extensions",
    "events",
    "webhooks",
    "type_crud",
    "audit",
    "metrics",
    "edges",
    "admin_archive",
  ];
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
  app.route("/health", healthRoutes(storage, blobBackend, config));

  // Auth middleware runs BEFORE rate limiting so the limiter can key on
  // the credential id (per-credential enforcement). Anonymous requests
  // still fall through to IP-based limiting inside rateLimitMiddleware.
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // Rate limiting (default 1000 req/min). Protects all endpoints.
  if (config.rateLimitEnabled) {
    app.use(
      "*",
      rateLimitMiddleware({
        defaultLimit: Number(process.env.RATE_LIMIT_REQUESTS) || 1000,
        windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
        pathLimits: { "/keys": 200, "/auth/token": 20 },
        trustedProxyCidrs: config.trustedProxyCidrs,
      }),
    );
  }

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", bulkRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/items", itemEdgeListingRoutes(storage));
  app.route("/edges", edgeRoutes(storage));
  app.route("/edges", edgeTypeRoutes(storage));
  app.route("/types", typeRoutes(storage));
  app.route("/search", searchRoutes(storage));
  app.route("/metadata", metadataRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend, config.maxBlobSize));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/tenants", tenantRoutes(storage));
  app.route("/admin", adminArchiveRoutes(storage, blobBackend));
  app.route("/export", exportRoutes(storage, blobBackend));
  app.route("/auth", authRoutes(storage, config.apiKeySalt));
  if (config.authMode === "hosted" && storage.users && storage.tenants) {
    app.route("/auth", userAuthRoutes(storage, config.apiKeySalt));
  }
  app.route("/events", eventRoutes(storage));
  app.route("/webhooks", webhookRoutes(storage));
  app.route("/audit", auditRoutes(storage));
  app.route("/metrics", metricsRoutes(storage));

  // OpenAPI spec — generated from route definitions
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "API Key or OAuth Token",
    description:
      "Pass an API key (myme_k1_...) or OAuth access token (myme_at_...)",
  });
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Myme API",
      version: "0.1.0",
      description: "Typed data layer for structured personal data",
    },
  });

  return app;
}
