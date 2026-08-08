import { OpenAPIHono } from "@hono/zod-openapi";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "./openapi-finalize.js";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppConfig } from "./config.js";
import { getPermissionBundles } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import { authMiddleware } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import type { MarfaAuth } from "./auth/instance.js";
import { createMarfaAuth } from "./auth/instance.js";
import type { OidcSigner } from "./auth/oidc-signing.js";
import { itemRoutes } from "./routes/items.js";
import { oauthProtectedResourceRoutes } from "./routes/oauth-protected-resource.js";
import { mcpRoutes } from "./routes/mcp.js";
import { bulkRoutes } from "./routes/bulk.js";
import { bulkGetRoutes } from "./routes/bulk-get.js";
import { edgeRoutes, itemEdgeListingRoutes } from "./routes/edges.js";
import { edgesBulkRoutes } from "./routes/edges-bulk.js";
import { edgeTypeRoutes } from "./routes/edge-types.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { occurrenceRoutes } from "./routes/occurrences.js";
import { metadataRoutes } from "./routes/metadata.js";
import { blobRoutes } from "./routes/blobs.js";
import { profileRoutes } from "./routes/profile.js";
import { keyRoutes } from "./routes/keys.js";
import { runtimeCredentialRoutes } from "./routes/runtime-credentials.js";
import { credentialRoutes } from "./routes/credentials.js";
import { integrationRoutes } from "./routes/integrations.js";
import { exportRoutes } from "./routes/export.js";
import { adminArchiveRoutes } from "./routes/admin-archive.js";
import { authRoutes } from "./routes/auth-pages.js";
import { oauthRegisterRoutes } from "./routes/oauth-register.js";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { authStaticRoutes } from "./routes/auth-static.js";
import { renderHttpErrorPage, prefersHtml } from "./routes/http-error-page.js";
import type { EmailTransport as MarfaEmailTransport } from "./email/transport.js";
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
import { connectionConfigureRoutes } from "./routes/connection-configure.js";
import { auditRoutes } from "./routes/audit.js";
import { metricsRoutes } from "./routes/metrics.js";
import { adminRoutes } from "./routes/admin.js";
import { userAuthRoutes } from "./routes/users.js";
import { spaceRoutes } from "./routes/spaces.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { clientIpMiddleware } from "./middleware/client-ip.js";
import { cycleMiddleware } from "./middleware/cycle.js";
import { spaceSuspensionMiddleware } from "./middleware/space-suspension.js";
import { createAccountDeletionGate } from "./middleware/account-deletion-guard.js";
import { authAccountRoutes } from "./routes/auth-account.js";
import { authConsentRoutes } from "./routes/auth-consent.js";
import { authErrorRoutes } from "./routes/auth-error.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { otelCorrelationMiddleware } from "./middleware/otel-correlation.js";
import { rlsSpaceContextMiddleware } from "./middleware/rls-space-context.js";
import type { PgClient, PgDb } from "./storage/pg/connection.js";
import { healthRoutes } from "./routes/health.js";
export function createApp(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
  emailTransport?: MarfaEmailTransport,
  oidcSigner?: OidcSigner,
  /**
   * Optional Hono sub-app mounted at the root path before any auth
   * middleware. The local-runtime substrate uses this to expose
   * `POST /runtime/webhook/:connection_id` without going through the
   * bearer-token gate (verification happens at the route via the
   * subscription's HMAC secret).
   */
  localRuntimeApp?: import("hono").Hono,
) {
  const app = new OpenAPIHono<AppEnv>();

  // Global error handler
  app.onError(
    createErrorHandler({
      errorWebhookUrl: config.errorWebhookUrl,
      errorWebhookTimeoutMs: config.errorWebhookTimeoutMs,
    }),
  );

  // An unmatched route never throws, so it never reaches `onError` — Hono
  // answers it with a bare `404 Not Found` in plain text. That is the one
  // error a person is most likely to reach by hand, from a mistyped address
  // or a link that has moved, and it was the least presentable thing the
  // server produced. Same negotiation as every other error: a page for a
  // browser, the documented JSON shape for everything else.
  app.notFound((c) => {
    const body = {
      error: { code: "not_found", message: "Not found" },
    };
    if (prefersHtml(c.req.header("accept"))) {
      return c.html(renderHttpErrorPage(404), 404);
    }
    return c.json(body, 404);
  });

  // Expose the resolved AppConfig on the request context so handlers and
  // middleware (e.g. quota enforcement) read env-derived values from the
  // single config source rather than re-reading `process.env`.
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });

  // Structured logging (wraps entire request lifecycle)
  app.use("*", loggerMiddleware());

  // Stamp request_id / key_id / space_id onto the active OTel span and
  // mark 5xx as span errors. Pure no-op when OpenTelemetry is disabled
  // (no active span). After the logger so `requestId` is already set.
  app.use("*", otelCorrelationMiddleware());

  // CORS — explicit origins from config. In non-production, any
  // localhost/127.0.0.1 origin (any port) is also reflected so the
  // local dev loop (Vite on a shifting port, curl, etc.) works without
  // enumerating every port in CORS_ORIGINS. In production that
  // auto-reflect is OFF: an operator must list real dev origins in
  // CORS_ORIGINS explicitly, so a hosted deployment can't be coerced
  // into echoing an attacker-controlled `http://localhost:<port>`
  // Origin back as allowed.
  const reflectLocalhost = !config.isProduction;
  if (config.corsOrigins.length > 0) {
    app.use(
      "*",
      cors({
        origin: (origin) => {
          if (!origin) return config.corsOrigins[0];
          if (config.corsOrigins.includes(origin)) return origin;
          if (reflectLocalhost) {
            try {
              const url = new URL(origin);
              if (
                url.hostname === "localhost" ||
                url.hostname === "127.0.0.1"
              ) {
                return origin;
              }
            } catch {
              // invalid origin, ignore
            }
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

  // Global request-body size cap for the JSON write surface — a
  // memory-exhaustion DoS guard. `bodyLimit` rejects (via Content-Length
  // and a streaming counter) anything over `maxRequestBytes` with the
  // typed 413 `request_too_large` (thrown so the global error handler
  // emits the correct code + status). Mounted after `secureHeaders` and
  // before auth so an oversized unauthenticated body is rejected cheaply.
  //
  // The blob (`/blobs`) and avatar (`/profile`) upload routes are exempt:
  // they legitimately accept up to `maxBlobSize` (50 MB default) and
  // enforce their own cap inside the handler, returning `blob_too_large`.
  // Applying the small global cap to them would reject valid uploads, so
  // the middleware is a no-op for those path prefixes.
  const tooLarge = () => {
    throw new MarfaError(ErrorCode.REQUEST_TOO_LARGE, "Request body too large");
  };
  const requestBodyLimit = bodyLimit({
    maxSize: config.maxRequestBytes,
    onError: tooLarge,
  });
  // Bulk write endpoints (`/items/bulk*`, `/edges/bulk`) carry up to 5000
  // items/edges in a single body, so the tight per-request cap would reject
  // legitimate batches. They get a higher dedicated cap
  // (`MARFA_MAX_BULK_REQUEST_BYTES`, default 16 MB); the bulk routes still
  // bound the item count (5000) and the per-field caps still apply.
  const bulkBodyLimit = bodyLimit({
    maxSize: config.maxBulkRequestBytes ?? 16 * 1024 * 1024,
    onError: tooLarge,
  });
  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const path = c.req.path;
      if (path.startsWith("/blobs") || path.startsWith("/profile")) {
        return next();
      }
      if (path.startsWith("/items/bulk") || path.startsWith("/edges/bulk")) {
        return bulkBodyLimit(c, next);
      }
      return requestBodyLimit(c, next);
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
      name: "marfa",
      version: deployedVersion,
      features,
      cdn_base_url: config.cdnBaseUrl || null,
    }),
  );
  app.route("/health", healthRoutes(storage, blobBackend, config));

  // Local-runtime substrate routes (POST /runtime/webhook/:id). Mounted
  // before any auth middleware so the public webhook receipt endpoint
  // stays unauthenticated — verification happens inside the route via
  // the subscription's HMAC secret.
  if (localRuntimeApp) {
    app.route("/", localRuntimeApp);
  }

  // OAuth 2.1 / OIDC discovery — owned by the @better-auth/oauth-provider
  // plugin. The plugin auto-mounts the docs under its basePath (`/auth`)
  // but per RFC 8414 / OIDC Discovery, RPs probe the bare-root paths.
  // The plugin ships exportable helpers that re-publish the same metadata
  // at the root. JWKS stays at the plugin's `/auth/jwks` — the discovery
  // doc points there, so RPs that read the doc will follow correctly.

  // Shared auth-page stylesheet. Public — anyone landing on `/auth/sign-in`
  // must be able to fetch the CSS without a session cookie. Mounted BEFORE
  // authMiddleware AND before the better-auth catch-all so
  // `/auth/static/auth.css` resolves to the static handler rather than
  // falling through to `/auth/*`.
  app.route("/auth/static", authStaticRoutes());

  // Resolve the effective client IP once per request and stash it on
  // `c.var.clientIp`. Runs BEFORE auth so audit rows emitted from
  // auth-side paths (e.g. token revocation) and route handlers alike
  // can attribute the originator without re-resolving each time.
  app.use("*", clientIpMiddleware(config.trustedProxyCidrs));

  // Auth middleware runs BEFORE rate limiting so the limiter can key on
  // the credential id (per-credential enforcement). Anonymous requests
  // still fall through to IP-based limiting inside rateLimitMiddleware.
  app.use("*", authMiddleware(storage, config.apiKeySalt, config.authMode));

  // Space-suspension write-guard. Sits AFTER `authMiddleware` so the
  // credential is resolved when this runs. Rejects every non-GET request
  // from a non-platform credential whose space is suspended with HTTP 403
  // `space_suspended`. Reads pass through; platform-admin keys bypass so
  // operators can manage a suspended space.
  app.use("*", spaceSuspensionMiddleware(storage));

  // Block sign-ins on accounts in `pending_deletion`. Mounted AFTER the
  // space suspension guard so suspended-space rejection still wins.
  // Only triggers on the better-auth sign-in paths — every other path
  // is a pass-through. The gate is created once so its in-memory cancel-
  // email cooldown is SHARED between the middleware (better-auth JSON
  // sign-in endpoints) and the human-facing `POST /auth/sign-in` wrapper,
  // which dispatches to `auth.handler` directly and so bypasses Hono
  // middleware — `deletionGate.evaluatePendingDeletion` is threaded into
  // `authRoutes` below to guard that form path too.
  const deletionGate = createAccountDeletionGate(
    storage,
    emailTransport,
    config.authBaseUrl,
    config.accountDeletionGraceDays ?? 30,
  );
  app.use("*", deletionGate.middleware);

  // Cycle metadata resolution. Reads X-Marfa-Cycle-Origin /
  // X-Marfa-Cycle-Hop headers (an integration continuing a chain) or falls
  // back to the api key's connection binding (an integration kicking off a
  // chain). Mounted AFTER auth because the fallback path reads
  // `c.var.apiKey`. The resolved cycle is written to BOTH `c.var.cycle`
  // (diagnostic) AND `cycleRequestContext` (AsyncLocalStorage) so
  // `publish()` in `pubsub.ts` reads it automatically — routes do not
  // thread `...c.var.cycle` into every publish call.
  app.use("*", cycleMiddleware());

  // Rate limiting (defaults: 1000 req/min, configurable via RATE_LIMIT_REQUESTS
  // and RATE_LIMIT_WINDOW_MS). Protects all endpoints. Configuration flows
  // through AppConfig — the rate-limit middleware reads its settings from
  // there, not process.env, so there is a single env-read site (loadConfig).
  if (config.rateLimitEnabled) {
    app.use(
      "*",
      rateLimitMiddleware({
        defaultLimit: config.rateLimitDefaultLimit,
        windowMs: config.rateLimitWindowMs,
        pathLimits: {
          "/keys": 200,
          // Insertion order matters: the middleware iterates and
          // takes the FIRST `path.startsWith(prefix)` match, so
          // place more-specific prefixes ahead of broader siblings
          // (e.g. `/auth/device/token` MUST precede `/auth/device`,
          // and `/auth/sign-in/magic-link` MUST precede `/auth/sign-in`).
          //
          // Auth-endpoint caps calibrated for realistic human retry
          // patterns plus iterative smoke testing. The global default
          // (1000/window) bounds anything else.
          //
          // Device-flow polling (`/auth/device/token`) gets its own
          // budget independent of the sign-in / token-exchange paths:
          // RFC 8628's default 5-second poll interval means a single
          // in-flight device flow burns 12 calls/minute, so 60/min
          // accommodates ~5 concurrent flows without sharing budget
          // with `/auth/oauth2/token`.
          //
          // The per-email throttle on `/auth/forgot-password`
          // (3/hour, in-route) is the inner cap; the per-IP cap
          // here is the outer cap that prevents a single client
          // botnet from running thousands of reset attempts across
          // many addresses in one window.
          "/auth/device/token": 60,
          "/auth/device": 30,
          "/auth/sign-in/magic-link": 15,
          "/auth/sign-in/email": 30,
          "/auth/sign-in": 30,
          "/auth/sign-up": 15,
          "/auth/forgot-password": 15,
          "/auth/reset-password": 30,
          "/auth/verify-email/resend": 15,
          // Cap the OAuth2 plugin endpoints (`/auth/oauth2/*`). Without
          // this, every plugin endpoint inherits the global default
          // (1000/min) — particularly bad for DCR (`/auth/oauth2/register`)
          // which is unauthenticated. Specific prefixes appear BEFORE
          // broader siblings per the insertion-order match rule.
          //
          // `/auth/authorize/decision` (Marfa proxy) precedes
          // `/auth/authorize` (Marfa consent render).
          "/auth/oauth2/register": 10,
          "/auth/oauth2/token": 60,
          "/auth/oauth2/introspect": 60,
          "/auth/oauth2/revoke": 30,
          "/auth/oauth2/consent": 30,
          "/auth/oauth2/authorize": 30,
          "/auth/authorize/decision": 30,
          "/auth/authorize": 60,
          // The old `/auth/token` route has been removed; the plugin lives
          // at `/auth/oauth2/token`. This entry is intentionally absent
          // to avoid a dead prefix in the table.
        },
        trustedProxyCidrs: config.trustedProxyCidrs,
        // Per-space rate ceiling on top of the per-credential window.
        // Reads space_quotas.rate_per_minute_limit (with env fallback)
        // via a 60s in-process cache. No-op for space-less keys.
        storage,
        spaceDefaultRatePerMinute: config.defaultQuotaRatePerMinute ?? null,
        // Aggregate per-identifier cap (defaultLimit × multiplier),
        // keyed on the identifier with no path split, so a key's budget
        // can't multiply across path groups and space-less identifiers
        // still hit a ceiling. `0` disables it.
        aggregateMultiplier: config.rateLimitAggregateMultiplier,
      }),
    );
  }

  // Postgres RLS request-level enforcement. Wraps each space-bounded
  // request in a transaction with `SET LOCAL ROLE marfa_app` and
  // `set_config('marfa.space_id', $space, true)` so the per-table RLS
  // policies actually filter queries. Pass-through when
  // `MARFA_RLS_ENFORCE=false`, when storage is SQLite (`pgDb` undefined),
  // or when the request has no space on its api key (platform admin /
  // public routes). See `middleware/rls-space-context.ts` for the full
  // contract — including the streaming-response exemption.
  app.use(
    "*",
    rlsSpaceContextMiddleware({
      rlsEnforce: config.rlsEnforce ?? false,
      db: (storage.pgDb as PgDb | undefined) ?? null,
    }),
  );

  // Better Auth setup. Instance is created up front so it can be passed
  // into authRoutes (the OAuth consent screen consumes its cookie-based
  // getSession to gate `/auth/authorize`). The catch-all `/auth/*` mount
  // is registered AFTER the explicit /auth routes so explicit handlers
  // win for `/auth/clients`, `/auth/authorize`, `/auth/oauth2/*`, etc.
  //
  // §3.13: the better-auth handles are typed fields on the Storage
  // interface (BetterAuthStorageAdapter trait). No `as` cast needed —
  // both fields are optional, so a Storage that doesn't wire better-auth
  // simply skips the auth mount.
  let auth: MarfaAuth | undefined;
  if (storage.betterAuthDb && storage.betterAuthDialect) {
    const trustedOrigins = [config.authBaseUrl, ...config.corsOrigins].filter(
      Boolean,
    );
    auth = createMarfaAuth({
      db: storage.betterAuthDb,
      dialect: storage.betterAuthDialect,
      baseURL: config.authBaseUrl,
      allowSignup: config.authAllowSignup,
      seedStarterContent: config.seedStarterContent,
      secret: config.authSecret || undefined,
      trustedOrigins,
      oidcProviders: config.oidcProviders,
      // Rich transport carries the HTML template + idempotency key
      // for log correlation. Falls back to the basic callable for
      // tests that don't construct a full transport.
      marfaEmailTransport: emailTransport,
      // storage + salt are needed by the @better-auth/oauth-provider plugin
      // (storeTokens.hash matches Marfa's hashApiKey, clientReference
      // resolves space_id, hooks.after projects grants into system.connection).
      storage,
      apiKeySalt: config.apiKeySalt,
      // Opt-in override for `requireEmailVerification`. When unset, the
      // auth layer auto-detects from the transport (on for
      // `cloudflare`/`smtp`, off for `none`/missing).
      ...(config.authRequireEmailVerification !== undefined && {
        requireEmailVerification: config.authRequireEmailVerification,
      }),
    });
  }

  // Bare-root discovery (RFC 8414 + OIDC Discovery). The plugin auto-publishes
  // the same metadata at `/auth/.well-known/*` via its basePath, but most RPs
  // only probe the bare-root paths. These two helpers re-publish the same
  // response payload. The discovery doc points RPs at the actual endpoint paths
  // (e.g. `/auth/oauth2/token`, `/auth/jwks`) — no further root aliasing is needed.
  //
  // The plugin's helper does NOT advertise the device-code grant type or the
  // `device_authorization_endpoint` field (RFC 8628 §4) by default. Marfa owns
  // the device-flow surface at `/auth/device` + `/auth/device/token`, so we
  // wrap the plugin's response and inject both before returning. Passing the
  // device-code URN via the plugin's `grantTypes` config causes its token
  // endpoint to 400 with `unsupported_grant_type` — the plugin has no case
  // branch for it. Augmenting the metadata here keeps the plugin's token
  // endpoint behavior intact.
  if (auth) {
    // Cast once into the shape both helpers want — they each declare a
    // narrow `api` requirement (`getOAuthServerConfig` vs `getOpenIdConfig`).
    // The runtime `auth.api` carries both, but the type system can't see
    // through the plugin's union-of-api shapes without an explicit hint.
    const authForHelpers = auth as unknown as Parameters<
      typeof oauthProviderAuthServerMetadata
    >[0] &
      Parameters<typeof oauthProviderOpenIdConfigMetadata>[0];
    const authServerMeta = oauthProviderAuthServerMetadata(authForHelpers);
    const openidConfigMeta = oauthProviderOpenIdConfigMetadata(authForHelpers);
    const augmentMetadata = async (
      handler: (req: Request) => Promise<Response>,
      baseURL: string,
      req: Request,
    ): Promise<Response> => {
      const upstream = await handler(req);
      // Bail unconditionally on non-200 — the plugin returns no body
      // shape we can amend safely. Preserves cache headers etc.
      if (!upstream.ok) return upstream;
      let payload: Record<string, unknown>;
      try {
        payload = (await upstream.json()) as Record<string, unknown>;
      } catch {
        return upstream;
      }
      // Inject the device-code URN into `grant_types_supported`
      // (idempotent — guards against the plugin starting to advertise
      // it natively in a future version).
      const URN = "urn:ietf:params:oauth:grant-type:device_code";
      const grantsRaw = payload.grant_types_supported;
      const grants = Array.isArray(grantsRaw)
        ? grantsRaw.filter((g): g is string => typeof g === "string")
        : [];
      if (!grants.includes(URN)) grants.push(URN);
      payload.grant_types_supported = grants;
      // RFC 8628 §4: `device_authorization_endpoint` advertises the
      // device-authorization request endpoint. Marfa's lives at
      // `${authBaseUrl}/auth/device` (initiation; the polled token
      // exchange happens at `/auth/device/token`).
      payload.device_authorization_endpoint = `${baseURL.replace(/\/+$/, "")}/auth/device`;
      // Marfa extension: advertise the named permission bundles so clients
      // can render / request the bundled consent without hard-coding the
      // scope grammar. Non-standard field; OIDC/OAuth RPs ignore it.
      payload.marfa_permission_bundles =
        config.permissionBundles ?? getPermissionBundles();
      const headers = new Headers(upstream.headers);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(payload), {
        status: upstream.status,
        headers,
      });
    };
    app.get("/.well-known/oauth-authorization-server", (c) =>
      augmentMetadata(authServerMeta, config.authBaseUrl, c.req.raw),
    );
    app.get("/.well-known/openid-configuration", (c) =>
      augmentMetadata(openidConfigMeta, config.authBaseUrl, c.req.raw),
    );
    // RFC 8414 §3.1 forms the metadata URL by inserting the well-known
    // segment between host and issuer path, and OIDC discovery appends its
    // segment to the issuer. The issuer here is `<base>/auth`, so a
    // spec-following client requests the path-aware URLs below — the
    // bare-root copies above predate that reading and stay for the RPs
    // already pinned to them. All serve the same augmented document. The
    // issuer-suffixed OIDC path resolves here because these registrations
    // run before the `/auth/*` catch-all mounts.
    app.get("/.well-known/oauth-authorization-server/auth", (c) =>
      augmentMetadata(authServerMeta, config.authBaseUrl, c.req.raw),
    );
    app.get("/.well-known/openid-configuration/auth", (c) =>
      augmentMetadata(openidConfigMeta, config.authBaseUrl, c.req.raw),
    );
    app.get("/auth/.well-known/openid-configuration", (c) =>
      augmentMetadata(openidConfigMeta, config.authBaseUrl, c.req.raw),
    );
    // RFC 9728: the resource-server metadata a bearer challenge points at.
    app.route("/", oauthProtectedResourceRoutes(config));
  }

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", bulkRoutes(storage));
  app.route("/items", bulkGetRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/items", itemEdgeListingRoutes(storage));
  app.route("/edges", edgeRoutes(storage));
  app.route("/edges", edgesBulkRoutes(storage));
  app.route("/edge-types", edgeTypeRoutes(storage));
  app.route("/types", typeRoutes(storage));
  app.route("/search", searchRoutes(storage));
  app.route("/occurrences", occurrenceRoutes(storage));
  app.route("/metadata", metadataRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobBackend, config.maxBlobSize));
  // Profile endpoints. Mounted after /blobs so the avatar set path can
  // reuse the blob layer; the placeholder SVG endpoint is public (no
  // auth) but lives under /profile for path locality.
  app.route(
    "/profile",
    profileRoutes(storage, blobBackend, config.maxBlobSize),
  );
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/credentials", credentialRoutes(storage));
  app.route(
    "/system",
    runtimeCredentialRoutes(storage, config.apiKeySalt, config.authMode),
  );
  app.route(
    "/integrations",
    integrationRoutes(storage, config.apiKeySalt, auth),
  );
  app.route("/spaces", spaceRoutes(storage));
  app.route("/admin", adminArchiveRoutes(storage, blobBackend));
  // Streaming routes receive `rlsEnforce` + `pgClient` so they can apply
  // session-level RLS on a dedicated pool connection for the stream's
  // lifetime — closing the bypass that the per-request transaction
  // middleware can't cover. SQLite + space-less callers continue to run
  // on the owner connection (no DB-level fence).
  const streamingRoutesOptions = {
    rlsEnforce: config.rlsEnforce ?? false,
    // Prefer the dedicated stream client (direct/session-mode endpoint) so
    // streaming's session-level `SET ROLE` can't strand on the app's
    // transaction-mode pooled connections; fall back to the main client when
    // no direct endpoint is configured.
    pgClient:
      ((storage.pgStreamClient ?? storage.pgClient) as PgClient | undefined) ??
      null,
  };
  app.route(
    "/export",
    exportRoutes(storage, blobBackend, streamingRoutesOptions),
  );
  app.route(
    "/auth",
    authRoutes(
      storage,
      config.apiKeySalt,
      auth,
      oidcSigner,
      deletionGate.evaluatePendingDeletion,
    ),
  );
  if (config.authMode === "hosted" && storage.users && storage.spaces) {
    app.route("/auth", userAuthRoutes(storage));
  }
  // Account-lifecycle routes — initiate / confirm / cancel. Mounted
  // BEFORE the better-auth catch-all so the explicit handlers win for
  // `/auth/account/*`.
  app.route(
    "/auth",
    authAccountRoutes(
      storage,
      auth,
      emailTransport,
      config.authBaseUrl,
      config.accountDeletionGraceDays ?? 30,
    ),
  );
  // `/auth/authorize` consent page (the @better-auth/oauth-provider plugin's
  // `consentPage` redirect target). Mounted BEFORE the better-auth catch-all
  // so this explicit GET handler wins over the plugin's own endpoints under
  // /auth/oauth2/*.
  app.route(
    "/auth",
    authConsentRoutes({
      storage,
      auth,
      corsOrigins: config.corsOrigins,
      authBaseUrl: config.authBaseUrl,
    }),
  );
  // Marfa-owned DCR endpoint. Sits in front of the plugin's
  // `/auth/oauth2/register` because: (1) the plugin's body schema rejects
  // the device-code URN at validation time, and (2) the plugin's write path
  // through Better Auth's Drizzle adapter mishandles `string[]` columns on
  // the PG provider. See `routes/oauth-register.ts` for the upstream source
  // references.
  if (storage.oauthProvider) {
    app.route(
      "/auth",
      oauthRegisterRoutes(
        storage,
        storage.oauthProvider,
        auth,
        config.corsOrigins,
      ),
    );
  }

  // Marfa-owned /auth/error page. The @better-auth/oauth-provider plugin
  // redirects unrecoverable authorize failures here (e.g. invalid_client from
  // a stale client_id); without this explicit route the better-auth core
  // handler 302s to the API root JSON in production. Mounted before the
  // catch-all so this GET wins.
  app.route("/auth", authErrorRoutes());

  // Better-auth catch-all for unmatched /auth/* paths (sign-in, sign-up,
  // magic-link, passkey, federated OIDC, session, plus the oauth-provider
  // plugin's /auth/oauth2/* endpoints). Hono dispatches in registration
  // order — the explicit routes above win.
  if (auth) {
    const authInstance = auth;
    app.on(["POST", "GET"], "/auth/*", (c) => authInstance.handler(c.req.raw));
  }

  app.route("/events", eventRoutes(storage, streamingRoutesOptions));
  // Inbound subscription management (admin/integration auth) lives under
  // /connections/:id/inbound-webhooks. Mounted before /webhooks so the
  // public receipt path /webhooks/inbound/:id resolves correctly.
  app.route("/connections", inboundWebhookSubscriptionRoutes(storage));
  // Connection OAuth proxy — POST/GET/etc.
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
      authMode: config.authMode,
    }),
  );
  app.route("/oauth/callback", oauthCallbackRoutes(storage));
  // Leased bearer tokens — issuance + revoke + list under
  // /connections/:id/lease-tokens; introspection at
  // /lease-tokens/validate (separate router so it can be reached by
  // upstream services that don't otherwise touch /connections).
  app.route("/connections", connectionLeasedTokenRoutes(storage));
  // Connection management — POST /connections/:id/uninstall (admin-gated)
  // orchestrates a full teardown across credentials, OAuth tokens, leased
  // tokens, inbound webhooks, and the connection's lifecycle state.
  app.route(
    "/connections",
    connectionRoutes(storage, config.apiKeySalt, {
      integrationRuntime: config.integrationRuntime ?? "local",
    }),
  );
  app.route("/connections", connectionConfigureRoutes(storage));
  app.route("/lease-tokens", leaseTokenValidationRoutes(storage));
  app.route("/webhooks/inbound", inboundWebhookReceiptRoutes(storage));
  app.route("/webhooks", webhookRoutes(storage));
  app.route("/audit", auditRoutes(storage));
  app.route("/metrics", metricsRoutes(storage));
  // Operator surface — `my platform` CLI calls into these.
  app.route(
    "/admin",
    adminRoutes(storage, {
      graceDays: config.accountDeletionGraceDays ?? 30,
      apiKeySalt: config.apiKeySalt,
    }),
  );

  // OpenAPI spec — generated from route definitions
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "API Key or OAuth Token",
    description:
      "Authenticate with an API key (`marfa_k1_…`) or an OAuth access token (`marfa_at_…`).",
  });
  // `finalizeOpenAPISpec` shapes the public reference (ordered tags, internal
  // operations stripped, plain-Hono routes injected) — shared with the
  // committed spec in `src/openapi-published.ts` so the two never drift.
  //
  // This document deliberately describes THIS deployment: routes mounted only
  // under another auth mode are absent, because they are absent from the
  // running server. The committed spec is the wider contract across every
  // mode, and marks which operations a given mode serves.
  const openapiDocument = finalizeOpenAPISpec(
    app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  );
  app.get("/openapi.json", (c) => c.json(openapiDocument));

  // The remote agent surface. Mounted last and wired as a closure over the
  // composed app so tool calls dispatch back through the full middleware
  // stack in process; a plain Hono route (streaming, protocol-owned wire
  // shapes) that stays out of the OpenAPI document like SSE and export.
  if (config.mcpEnabled) {
    app.route(
      "/mcp",
      mcpRoutes({
        authBaseUrl: config.authBaseUrl,
        hasAuthServer: Boolean(auth),
        toolsets: config.mcpToolsets,
        appFetch: (req) => app.fetch(req),
      }),
    );
  }

  return app;
}
