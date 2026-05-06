import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { MymeAuth } from "./auth/instance.js";
import { createMymeAuth } from "./auth/instance.js";
import { itemRoutes } from "./routes/items.js";
import { bulkRoutes } from "./routes/bulk.js";
import { edgeRoutes, itemEdgeListingRoutes } from "./routes/edges.js";
import { edgesBulkRoutes } from "./routes/edges-bulk.js";
import { edgeTypeRoutes } from "./routes/edge-types.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { metadataRoutes } from "./routes/metadata.js";
import { blobRoutes } from "./routes/blobs.js";
import { keyRoutes } from "./routes/keys.js";
import { runtimeCredentialRoutes } from "./routes/runtime-credentials.js";
import { integrationRoutes } from "./routes/integrations.js";
import { exportRoutes } from "./routes/export.js";
import { adminArchiveRoutes } from "./routes/admin-archive.js";
import { authRoutes, discoveryRoutes } from "./routes/oauth.js";
import { resendWebhookRoutes } from "./routes/webhooks-resend.js";
import type { EmailTransport as MymeEmailTransport } from "./email/transport.js";
import { extensionRoutes } from "./routes/extensions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookRoutes } from "./routes/webhooks.js";
import {
  inboundWebhookSubscriptionRoutes,
  inboundWebhookReceiptRoutes,
} from "./routes/inbound-webhooks.js";
import { connectionProxyRoutes } from "./routes/connection-proxy.js";
import {
  oauthStartRoutes,
  oauthCallbackRoutes,
} from "./routes/oauth-callback.js";
import {
  connectionLeasedTokenRoutes,
  leaseTokenValidationRoutes,
} from "./routes/connection-leased-tokens.js";
import { connectionRoutes } from "./routes/connections.js";
import { auditRoutes } from "./routes/audit.js";
import { metricsRoutes } from "./routes/metrics.js";
import { userAuthRoutes } from "./routes/users.js";
import { tenantRoutes } from "./routes/tenants.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { clientIpMiddleware } from "./middleware/client-ip.js";
import { cycleMiddleware } from "./middleware/cycle.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { rlsTenantContextMiddleware } from "./middleware/rls-tenant-context.js";
import type { PgDb } from "./storage/pg/connection.js";
import { healthRoutes } from "./routes/health.js";
export function createApp(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
  emailTransport?: MymeEmailTransport,
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

  // Security headers.
  //
  // `referrerPolicy` is overridden from Hono's default of `no-referrer`
  // to `strict-origin-when-cross-origin` — Chrome/Firefox's modern
  // default. Per Fetch spec §3.6.6, a `no-referrer` policy makes the
  // browser serialize the `Origin` header as the literal string
  // `"null"` on form-POST navigations, which Better Auth's CSRF
  // protection rejects with `MISSING_OR_NULL_ORIGIN`. The OAuth
  // consent flow needs `Origin` to round-trip from same-origin POSTs;
  // `strict-origin-when-cross-origin` preserves it for same-origin
  // and strips path information cross-origin (privacy intact).
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: config.enableHsts
        ? "max-age=63072000; includeSubDomains"
        : false,
      xFrameOptions: "DENY",
      xXssProtection: "1",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  // Public routes (before auth) — mounted directly to avoid prefix matching issues.
  //
  // The features array advertises the surfaces a client can expect to find on
  // this deployment. Keep it in sync with the routes mounted below; entries
  // here are an honest signal to discovery clients, not a marketing list.
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
    "inbound-webhooks",
    "type_crud",
    "audit",
    "metrics",
    "edges",
    "admin_archive",
    "connections",
    "integrations",
    "lease-tokens",
    "oauth-callback",
  ];
  if (config.authMode === "hosted") {
    features.push("users");
  }
  // §3.15: derive the deployed `version` from `version.json` (read at
  // startup by index.ts and threaded through `config.versionSha`). The
  // OpenAPI spec carries a separate, semantically-distinct API-contract
  // version (`info.version` below) — that's a stable literal bumped on
  // wire-shape changes, not on every deploy.
  const deployedVersion = config.versionSha ?? "dev";
  app.get("/", (c) =>
    c.json({
      name: "myme",
      version: deployedVersion,
      features,
      cdn_base_url: config.cdnBaseUrl || null,
    }),
  );
  app.route("/health", healthRoutes(storage, blobBackend, config));

  // Wave C PR1: Resend webhook receiver. Public route — Resend's
  // signed webhook is the gate (svix-style HMAC verified inside the
  // handler). Mounted BEFORE authMiddleware so the unauthenticated
  // path resolves cleanly. `RESEND_WEBHOOK_SECRET_MYME` must be
  // configured for verification to succeed; absent secret returns
  // 503 from inside the handler so Resend retries when the
  // operator wires it.
  app.route(
    "/webhooks/resend",
    resendWebhookRoutes(storage, config.resendWebhookSecret ?? ""),
  );

  // OAuth 2.1 discovery doc — public, unauthenticated.
  app.route("/.well-known", discoveryRoutes(config.authBaseUrl));

  // Resolve the effective client IP once per request and stash it on
  // `c.var.clientIp` (T-027). Runs BEFORE auth so audit rows emitted
  // from auth-side paths (e.g. token revocation) and route handlers
  // alike can attribute the originator without re-resolving each time.
  app.use("*", clientIpMiddleware(config.trustedProxyCidrs));

  // Auth middleware runs BEFORE rate limiting so the limiter can key on
  // the credential id (per-credential enforcement). Anonymous requests
  // still fall through to IP-based limiting inside rateLimitMiddleware.
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // Cycle metadata resolution (T-039). Reads X-Myme-Cycle-Origin /
  // X-Myme-Cycle-Hop headers (a connector continuing a chain) or falls
  // back to the api key's connection binding (a connector kicking off a
  // chain). Mounted AFTER auth because the fallback path reads
  // `c.var.apiKey`. Routes thread `c.var.cycle` into every `publish(...)`
  // call so the reactive-run bridge can self-suppress and the hop budget
  // gate can attribute by origin.
  app.use("*", cycleMiddleware());

  // Rate limiting (defaults: 1000 req/min, configurable via RATE_LIMIT_REQUESTS
  // and RATE_LIMIT_WINDOW_MS). Protects all endpoints. Configuration flows
  // through AppConfig — the rate-limit middleware no longer reads process.env
  // directly, so there is a single env-read site (loadConfig).
  if (config.rateLimitEnabled) {
    app.use(
      "*",
      rateLimitMiddleware({
        defaultLimit: config.rateLimitDefaultLimit,
        windowMs: config.rateLimitWindowMs,
        pathLimits: { "/keys": 200, "/auth/token": 20 },
        trustedProxyCidrs: config.trustedProxyCidrs,
        // T-052 follow-on (Wave B Part 2): per-tenant rate ceiling on
        // top of the per-credential window. Reads
        // tenant_quotas.rate_per_minute_limit (with env fallback) via
        // a 60s in-process cache. No-op for tenant-less keys.
        storage,
        tenantDefaultRatePerMinute: config.defaultQuotaRatePerMinute ?? null,
      }),
    );
  }

  // T-025 part 2: Postgres RLS request-level enforcement. Wraps each
  // tenant-bounded request in a transaction with `SET LOCAL ROLE
  // myme_app` and `set_config('myme.tenant_id', $tenant, true)` so
  // the per-table RLS policies (T-025 part 1) actually filter
  // queries. Pass-through when `MYME_RLS_ENFORCE=false` (the
  // default), when storage is SQLite (`pgDb` undefined), or when the
  // request has no tenant on its api key (platform admin / public
  // routes). See `middleware/rls-tenant-context.ts` for the full
  // contract — including the streaming-response exemption.
  app.use(
    "*",
    rlsTenantContextMiddleware({
      rlsEnforce: config.rlsEnforce ?? false,
      db: (storage.pgDb as PgDb | undefined) ?? null,
    }),
  );

  // Better Auth setup. Instance is created up front so it can be passed
  // into authRoutes (the OAuth consent screen consumes its cookie-based
  // getSession to gate `/auth/authorize`). The catch-all `/auth/*` mount
  // is registered AFTER the explicit /auth routes so explicit handlers
  // win for `/auth/clients`, `/auth/authorize`, `/auth/token`, etc.
  //
  // §3.13: the better-auth handles are typed fields on the Storage
  // interface (BetterAuthStorageAdapter trait). No `as` cast needed —
  // both fields are optional, so a Storage that doesn't wire better-auth
  // simply skips the auth mount.
  let auth: MymeAuth | undefined;
  if (storage.betterAuthDb && storage.betterAuthDialect) {
    const trustedOrigins = [config.authBaseUrl, ...config.corsOrigins].filter(
      Boolean,
    );
    auth = createMymeAuth({
      db: storage.betterAuthDb,
      dialect: storage.betterAuthDialect,
      baseURL: config.authBaseUrl,
      allowSignup: config.authAllowSignup,
      secret: config.authSecret || undefined,
      trustedOrigins,
      oidcProviders: config.oidcProviders,
      // Wave C PR1: rich transport carries the HTML template +
      // suppression check + idempotency + audit row. Falls back to
      // the legacy callable for tests that don't construct a full
      // transport.
      mymeEmailTransport: emailTransport,
    });
  }

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", bulkRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/items", itemEdgeListingRoutes(storage));
  app.route("/edges", edgeRoutes(storage));
  app.route("/edges", edgesBulkRoutes(storage));
  app.route("/edges", edgeTypeRoutes(storage));
  app.route("/types", typeRoutes(storage));
  app.route("/search", searchRoutes(storage));
  app.route("/metadata", metadataRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend, config.maxBlobSize));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/system", runtimeCredentialRoutes(storage, config.apiKeySalt));
  app.route("/integrations", integrationRoutes(storage, config.apiKeySalt));
  app.route("/tenants", tenantRoutes(storage));
  app.route("/admin", adminArchiveRoutes(storage, blobBackend));
  app.route("/export", exportRoutes(storage, blobBackend));
  app.route("/auth", authRoutes(storage, config.apiKeySalt, auth));
  if (config.authMode === "hosted" && storage.users && storage.tenants) {
    app.route("/auth", userAuthRoutes(storage, config.apiKeySalt));
  }

  // Better-auth catch-all for unmatched /auth/* paths (sign-in, sign-up,
  // magic-link, passkey, federated OIDC, session). Hono dispatches in
  // registration order — the explicit routes above win.
  if (auth) {
    const authInstance = auth;
    app.on(["POST", "GET"], "/auth/*", (c) => authInstance.handler(c.req.raw));
  }

  app.route("/events", eventRoutes(storage));
  // Inbound subscription management (admin/connector auth) lives under
  // /connections/:id/inbound-webhooks. Mounted before /webhooks so the
  // public receipt path /webhooks/inbound/:id resolves correctly.
  app.route("/connections", inboundWebhookSubscriptionRoutes(storage));
  // Connection OAuth proxy (workstream 2 PR 6) — POST/GET/etc.
  // /connections/:id/proxy/* forwards to the connection's configured
  // upstream URL with Authorization: Bearer <decrypted access_token>.
  app.route("/connections", connectionProxyRoutes(storage));
  // OAuth bootstrap — POST /connections/:id/oauth/start (admin-gated)
  // returns the upstream authorize URL with signed state; the public
  // GET /oauth/callback/:provider exchanges the code and persists
  // tokens under the same connectionOauthTokens row the proxy reads.
  app.route(
    "/connections",
    oauthStartRoutes(storage, {
      redirectUriAllowlist: config.oauthRedirectAllowlist,
    }),
  );
  app.route("/oauth/callback", oauthCallbackRoutes(storage));
  // Leased bearer tokens (workstream 2 PR 7) — issuance + revoke + list
  // under /connections/:id/lease-tokens; introspection at
  // /lease-tokens/validate (separate router so it can be reached by
  // upstream services that don't otherwise touch /connections).
  app.route("/connections", connectionLeasedTokenRoutes(storage));
  // Connection management — POST /connections/:id/uninstall (admin-gated)
  // orchestrates a full teardown across credentials, OAuth tokens, leased
  // tokens, inbound webhooks, and the connection's lifecycle state.
  app.route("/connections", connectionRoutes(storage, config.apiKeySalt));
  app.route("/lease-tokens", leaseTokenValidationRoutes(storage));
  app.route("/webhooks/inbound", inboundWebhookReceiptRoutes(storage));
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
  // §3.15 note: `info.version` here is the API-contract version (the wire
  // shape exposed under /openapi.json), distinct from the deployed-build
  // `version` reported on `GET /`. Keep this aligned with @mymehq/shared
  // (which defines the wire types) — bump on contract changes, not on
  // every deploy. The shared package is currently 4.2.x; the API
  // contract version tracks its major.minor.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Myme API",
      version: "4.2.0",
      description: "Typed data layer for structured personal data",
    },
  });

  return app;
}
