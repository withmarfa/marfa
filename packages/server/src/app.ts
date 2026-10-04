import { OpenAPIHono } from "@hono/zod-openapi";
import {
  EXPOSED_RESPONSE_HEADERS,
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "./openapi-finalize.js";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppConfig } from "./config.js";
import { DEFAULT_KEYS_RATE_LIMIT, getPermissionBundles } from "./config.js";
import type { AppEnv } from "./middleware/auth.js";
import {
  copyReadBoundary,
  invalidReadViewRequest,
} from "./middleware/read-view.js";
import { deriveKey, SECRET_INFO } from "./crypto/derive-key.js";
import { authMiddleware } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobLayer } from "./storage/blob-layer.js";
import type { MarfaAuth } from "./auth/instance.js";
import { createMarfaAuth } from "./auth/instance.js";
import { itemRoutes } from "./routes/items.js";
import { oauthProtectedResourceRoutes } from "./routes/oauth-protected-resource.js";
import { bulkRoutes } from "./routes/bulk.js";
import { bulkGetRoutes } from "./routes/bulk-get.js";
import { itemsLookupRoutes } from "./routes/items-lookup.js";
import { edgeRoutes, itemEdgeListingRoutes } from "./routes/edges.js";
import { edgesBulkRoutes } from "./routes/edges-bulk.js";
import { edgeTypeRoutes } from "./routes/edge-types.js";
import { typeRoutes } from "./routes/types.js";
import { searchRoutes } from "./routes/search.js";
import { occurrenceRoutes } from "./routes/occurrences.js";
import { metadataRoutes } from "./routes/metadata.js";
import { blobRoutes } from "./routes/blobs.js";
import { housekeepingRoutes } from "./routes/housekeeping.js";
import { connectorRoutes } from "./routes/connectors.js";
import { connectorStateRoutes } from "./routes/connector-state.js";
import { inboundRoutes } from "./routes/inbound.js";
import { folderRoutes } from "./routes/folders.js";
import type { Housekeeping } from "./housekeeping/scheduler.js";
import { keyRoutes } from "./routes/keys.js";
import { exportRoutes } from "./routes/export.js";
import { adminArchiveRoutes } from "./routes/admin-archive.js";
import { adminPlatformTypeRoutes } from "./routes/admin-platform-types.js";
import { ownerRoutes } from "./routes/owner.js";
import { authRoutes } from "./routes/auth-pages.js";
import { oauthPluginFenceRoutes } from "./routes/oauth-plugin-fence.js";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { authStaticRoutes } from "./routes/auth-static.js";
import { renderHttpErrorPage, prefersHtml } from "./routes/http-error-page.js";
import { extensionRoutes } from "./routes/extensions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { auditRoutes } from "./routes/audit.js";
import { metricsRoutes } from "./routes/metrics.js";
import { configRoutes } from "./routes/config.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { clientIpMiddleware } from "./middleware/client-ip.js";
import { authConsentRoutes } from "./routes/auth-consent.js";
import {
  BROWSER_FORM_DOORS,
  buildAllowedOrigins,
  crossOriginGuard,
} from "./routes/_cross-origin.js";
import { authErrorRoutes } from "./routes/auth-error.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { otelCorrelationMiddleware } from "./middleware/otel-correlation.js";
import { bodyCapFor, bulkBodyCap } from "./middleware/body-cap.js";
import { jsonDepthLimit } from "./middleware/json-depth.js";
import { CONTRACT_VERSION } from "./contract.js";
import { contractHeader } from "./middleware/contract-header.js";
import {
  idempotencyMiddleware,
  IDEMPOTENT_WRITE_DOORS,
} from "./middleware/idempotency.js";
import { healthRoutes, operatorCaller } from "./routes/health.js";
import { storageProbes } from "./routes/health-probes.js";
import {
  refuseUndeclaredKeysOf,
  refuseUndeclaredQueryKeys,
} from "./middleware/undeclared-query-keys.js";
export function createApp(
  storage: Storage,
  blobs: BlobLayer,
  /** The scheduler the housekeeping doors list and drive. Registered and
   *  started by the caller; the app only reads it and runs a housekeeping
   *  job on demand. */
  housekeeping: Housekeeping,
  config: AppConfig,
  /**
   * The name this instance answers to, resolved by the caller before the
   * app exists.
   *
   * Passed in rather than read per request, for two reasons.
   *
   * The root route must not be able to fail. It is what a client asks to
   * learn whether it is talking to a marfa server and which one, and a
   * handler that awaits the database answers `500` exactly when an operator
   * most needs it to answer — which is the failure `GET /health` is
   * deliberately built never to have.
   *
   * And three doors show this value. Resolving it here and handing it to
   * each makes "the three agree" true by construction rather than by every
   * call site happening to read the same row; `ensureInstanceId` resolves
   * it, and the server's boot is what calls that.
   */
  instanceId: string,
) {
  // The empty string is the one wrong value the type cannot refuse, and it
  // is what a caller reaching for a field that is not there hands over. An
  // instance serving `"instance_id": ""` names nothing, and does it with a
  // 200 on three doors — loud here beats quiet everywhere.
  if (instanceId === "") {
    throw new Error("createApp: instanceId is empty; resolve it first");
  }

  const app = new OpenAPIHono<AppEnv>();
  const readViewKey = deriveKey(config.authSecret, SECRET_INFO.readView);
  const readBoundary = copyReadBoundary(storage, instanceId, readViewKey);

  // Global error handler. Held in a variable because the idempotency
  // middleware renders a thrown error through this same handler rather
  // than re-deriving what it produces — a stored body that is nearly the
  // one that went out is worse than storing nothing.
  const errorHandler = createErrorHandler({
    errorWebhookUrl: config.errorWebhookUrl,
    errorWebhookTimeoutMs: config.errorWebhookTimeoutMs,
    authBaseUrl: config.authBaseUrl,
  });
  app.onError(errorHandler);

  // An unmatched route never throws, so it never reaches `onError`, and
  // Hono would answer it with a bare `404 Not Found` in plain text. That is
  // the one error a person is most likely to reach by hand, from a mistyped
  // address or a link that has moved, so it gets the same negotiation as
  // every other error: a page for a browser, the documented JSON shape for
  // everything else.
  app.notFound((c) => {
    if (
      c.req.method === "GET" &&
      c.req.header("X-Marfa-Read-View") !== undefined
    )
      throw invalidReadViewRequest(
        "This door does not support conditional copy reads",
      );
    const body = {
      error: { code: "not_found", message: "Not found" },
    };
    // The header every error the handler shapes carries. This response is
    // built here rather than thrown through the handler, so it sets the
    // header itself, and a client keying on `X-Error-Code` reads a 404 the
    // same way it reads every other refusal.
    c.header("X-Error-Code", "not_found");
    if (prefersHtml(c.req.header("accept"))) {
      return c.html(renderHttpErrorPage(404), 404);
    }
    return c.json(body, 404);
  });

  // Outermost, so every answer the application gives carries the contract
  // version, the ones no later layer shapes included.
  app.use("*", contractHeader());

  // Expose the resolved AppConfig on the request context so handlers and
  // middleware read env-derived values from the single config source
  // rather than re-reading `process.env`.
  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("copyReadBoundary", readBoundary);
    await next();
  });

  app.use("*", async (c, next) => {
    if (
      c.req.method === "GET" &&
      c.req.header("X-Marfa-Read-View") !== undefined &&
      !/^(?:\/items(?:\/[^/]+(?:\/edges)?)?|\/edges(?:\/[^/]+)?|\/types|\/edge-types|\/keys\/current|\/events)\/?$/.test(
        c.req.path,
      )
    )
      throw invalidReadViewRequest(
        "This door does not support conditional copy reads",
      );
    await next();
  });

  // Structured logging (wraps entire request lifecycle)
  app.use("*", loggerMiddleware());

  // Stamp request_id / key_id onto the active OTel span and
  // mark 5xx as span errors. Pure no-op when OpenTelemetry is disabled
  // (no active span). After the logger so `requestId` is already set.
  app.use("*", otelCorrelationMiddleware());

  // CORS — explicit origins from config. In non-production, any
  // localhost/127.0.0.1 origin (any port) is also reflected so the
  // local dev loop (Vite on a shifting port, curl, etc.) works without
  // enumerating every port in CORS_ORIGINS. In production that
  // auto-reflect is OFF: an operator must list real dev origins in
  // CORS_ORIGINS explicitly, so a production server can't be coerced
  // into echoing an attacker-controlled `http://localhost:<port>`
  // Origin back as allowed.
  const reflectLocalhost = !config.isProduction;
  if (config.corsOrigins.length > 0) {
    app.use(
      "*",
      cors({
        exposeHeaders: [...EXPOSED_RESPONSE_HEADERS],
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
  // Which doors take which cap is `bodyCapFor`'s.
  const tooLarge = () => {
    throw new MarfaError(ErrorCode.REQUEST_TOO_LARGE, "Request body too large");
  };
  const requestBodyLimit = bodyLimit({
    maxSize: config.maxRequestBytes,
    onError: tooLarge,
  });
  // `MARFA_MAX_BULK_REQUEST_BYTES`, default 16 MB; `bodyCapFor` says which
  // doors take it.
  const bulkBodyLimit = bodyLimit({
    maxSize: bulkBodyCap(config),
    onError: tooLarge,
  });
  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const cap = bodyCapFor(c.req.path);
      if (cap === "none" || cap === "inbound") return next();
      if (cap === "bulk") return bulkBodyLimit(c, next);
      return requestBodyLimit(c, next);
    }),
  );
  app.use("*", jsonDepthLimit);

  // Public routes (before auth) — mounted directly to avoid prefix matching issues.
  //
  // The features array advertises the surfaces a client can expect to find on
  // this deployment. Keep it in sync with the routes mounted below; entries
  // here are an honest signal to discovery clients, not a marketing list.
  //
  // Entries are lower_snake_case, stated rather than inferred from the
  // multi-word entries that happen to be here, because a reader cannot tell
  // a second convention from a typo.
  const features = [
    "items",
    "search",
    "blobs",
    "types",
    "keys",
    "bulk",
    "export",
    "oauth",
    "owner",
    "extensions",
    "events",
    "webhooks",
    "type_crud",
    "audit",
    "metrics",
    "edges",
    "admin_archive",
    "connectors",
    "inbound_webhooks",
  ];
  // The deployed `version` comes from `version.json`, read with the
  // settings at boot; `contract` is the
  // contract version, which does not move on a deploy.
  const deployedVersion = config.versionSha ?? "dev";
  // `instance_id` names the deployment, and the root is where a caller that
  // holds no credential can read it: the id is what distinguishes two
  // instances answering the same shape, which is exactly the question
  // somebody pointing a client at an address is asking.
  app.get("/", refuseUndeclaredQueryKeys([]), (c) =>
    c.json({
      name: "marfa",
      version: deployedVersion,
      instance_id: instanceId,
      contract: CONTRACT_VERSION,
      features,
    }),
  );
  // Ahead of the credential and the limiter, as the probe of a container
  // must be. It looks the operator key up for itself, because that key is
  // the one caller told what a failing component said.
  app.route(
    "/health",
    healthRoutes(
      storage,
      blobs,
      config,
      storageProbes(storage, {
        sqlitePath: config.sqlitePath,
        blobPath: config.blobPath,
      }),
      operatorCaller(storage, config.apiKeySalt),
    ),
  );

  // Shared auth-page stylesheet. Public — anyone landing on `/auth/sign-in`
  // must be able to fetch the CSS without a session cookie. Mounted BEFORE
  // authMiddleware AND before the better-auth catch-all so
  // `/auth/static/auth.css` resolves to the static handler rather than
  // falling through to `/auth/*`.
  app.route("/auth/static", authStaticRoutes());

  // Ahead of the credential and the limiter: a sender holds no key, and the
  // door keeps its own window per endpoint rather than per address.
  app.route("/inbound", inboundRoutes(storage, config));

  // Resolve the effective client IP once per request and stash it on
  // `c.var.clientIp`. Runs BEFORE auth so audit rows emitted from
  // auth-side paths (e.g. token revocation) and route handlers alike
  // can attribute the originator without re-resolving each time.
  app.use(
    "*",
    clientIpMiddleware(
      config.trustedProxyCidrs,
      config.trustedProxyHeader ?? null,
    ),
  );

  // Auth middleware runs BEFORE rate limiting so the limiter can key on
  // the credential id (per-credential enforcement). Anonymous requests
  // still fall through to IP-based limiting inside rateLimitMiddleware.
  app.use("*", authMiddleware(storage, config.apiKeySalt));

  // Rate limiting (defaults: 1000 req/min, configurable via RATE_LIMIT_REQUESTS,
  // RATE_LIMIT_WINDOW_MS and RATE_LIMIT_KEYS_REQUESTS). Protects every door
  // mounted below it; the root, `/health`, `/auth/static` and `/inbound`
  // sit above it, and `openapi-finalize.ts` declares the root that way. Configuration
  // flows through AppConfig: the rate-limit middleware reads its settings
  // from there rather than from `process.env`, so a deployment's limits are
  // whatever `loadConfig` resolved at boot.
  if (config.rateLimitEnabled) {
    app.use(
      "*",
      rateLimitMiddleware({
        defaultLimit: config.rateLimitDefaultLimit,
        windowMs: config.rateLimitWindowMs,
        pathLimits: {
          // The one cap an instance can name for itself
          // (`RATE_LIMIT_KEYS_REQUESTS`), on every door under `/keys`:
          // minting is how a caller widens its own reach, so the doors
          // that do it are held well under the default, and a deployment
          // whose callers legitimately mint more needs a number rather
          // than a fork. A key reading itself shares the allowance.
          "/keys": config.rateLimitKeysLimit ?? DEFAULT_KEYS_RATE_LIMIT,
          // Insertion order matters: the middleware iterates and
          // takes the FIRST `path.startsWith(prefix)` match, so
          // place more-specific prefixes ahead of broader siblings
          // (e.g. `/auth/device/code` MUST precede `/auth/device`).
          //
          // Auth-endpoint caps calibrated for realistic human retry
          // patterns plus iterative smoke testing. The global default
          // (1000/window) bounds anything else.
          //
          // Device-flow polling goes to `/auth/oauth2/token` with the
          // device grant and shares that endpoint's budget: RFC 8628's
          // default 5-second poll interval means one in-flight device flow
          // burns 12 calls/minute.
          "/auth/device/code": 30,
          "/auth/device": 30,
          "/auth/sign-in/email": 30,
          "/auth/sign-in": 30,
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
          "/auth/oauth2/authorize": 30,
          "/auth/authorize/decision": 30,
          "/auth/authorize": 60,
        },
        storage,
        // Aggregate per-identifier cap (defaultLimit × multiplier),
        // keyed on the identifier with no path split, so a key's budget
        // can't multiply across path groups and an unattributed identifier
        // still hits a ceiling. `0` disables it.
        aggregateMultiplier: config.rateLimitAggregateMultiplier,
      }),
    );
  }

  // `Idempotency-Key` on the doors in `IDEMPOTENT_WRITE_DOORS`, so a client that
  // lost a response can ask what its first attempt did instead of asking
  // the door again and being told about the second ask.
  //
  // **Registered outside any write transaction deliberately.** A claim has
  // to commit whether or not the write's own transaction does; inside it
  // the claim would roll back with a failed write and the retry would then
  // write for real.
  //
  // Registered per door through Hono's own router rather than matched by
  // hand: the table is the registered patterns, so the coverage test can
  // compare it against `app.routes` without a second notion of what a
  // path is.
  const idempotency = idempotencyMiddleware({ storage, errorHandler });
  for (const door of IDEMPOTENT_WRITE_DOORS) {
    const [method, path] = door.split(" ");
    if (method === undefined || path === undefined) continue;
    app.on(method, path, idempotency);
  }

  // Every browser door Marfa serves under `/auth` refuses a post from an
  // origin it does not trust, registered per door like the idempotency
  // middleware above so the census in `auth-origin-guard.test.ts` can hold
  // the list to `app.routes`.
  const originGuard = crossOriginGuard(
    buildAllowedOrigins(config.corsOrigins, config.authBaseUrl),
  );
  for (const door of BROWSER_FORM_DOORS) {
    const [method, path] = door.split(" ");
    if (method === undefined || path === undefined) continue;
    app.on(method, path, originGuard);
  }

  // Better Auth setup. Instance is created up front so it can be passed
  // into authRoutes (the OAuth consent screen consumes its cookie-based
  // getSession to gate `/auth/authorize`). The catch-all `/auth/*` mount
  // is registered AFTER the explicit /auth routes so explicit handlers
  // win for `/auth/clients`, `/auth/authorize`, `/auth/oauth2/*`, etc.
  //
  // The better-auth handle is one optional field on the Storage interface
  // (`BetterAuthStorageAdapter`), so a Storage that wires no better-auth
  // simply skips the auth mount.
  let auth: MarfaAuth | undefined;
  if (storage.betterAuthDb) {
    const trustedOrigins = [config.authBaseUrl, ...config.corsOrigins].filter(
      Boolean,
    );
    auth = createMarfaAuth({
      db: storage.betterAuthDb,
      baseURL: config.authBaseUrl,
      secret: config.authSecret,
      trustedOrigins,
      // storage + salt are needed by the @better-auth/oauth-provider plugin
      // (storeTokens.hash matches Marfa's hashApiKey, hooks.after projects
      // grants into system.connection).
      storage,
      apiKeySalt: config.apiKeySalt,
    });
  }

  // Discovery (RFC 8414 + OIDC Discovery). The discovery doc points RPs at the
  // actual endpoint paths (e.g. `/auth/oauth2/token`, `/auth/jwks`).
  //
  // The plugin also answers `/auth/.well-known/*` on its own basePath, and its
  // document is the unaugmented one. Every URL a client can derive is
  // registered here ahead of the `/auth/*` catch-all, so Hono answers first
  // and one document is served everywhere: the plugin's, with the `none`
  // revocation method and the permission bundles added below.
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
      // RFC 8414 §2: the revocation endpoint admits a public client presenting
      // its `client_id` alone, which is how every client this server issues
      // revokes. The plugin advertises only the confidential methods there
      // (secret in the header, secret in the body, private-key JWT) because
      // its one override covers introspection as well, where a secret is
      // required, so `none` is added here and to the revocation list only.
      // This helper serves the authorization-server document and the OpenID
      // ones alike, so both carry it. Without it a client reading the
      // document concludes it cannot revoke, and keeps a grant it meant to
      // end.
      const revocationRaw = payload.revocation_endpoint_auth_methods_supported;
      const revocationMethods = Array.isArray(revocationRaw)
        ? revocationRaw.filter((m): m is string => typeof m === "string")
        : [];
      if (!revocationMethods.includes("none")) revocationMethods.push("none");
      payload.revocation_endpoint_auth_methods_supported = revocationMethods;
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
    // RFC 8414 §3.1 forms the metadata URL by inserting the well-known
    // segment between host and issuer path, and OIDC discovery appends its
    // segment to the issuer. The issuer here is `<base>/auth`, so those are
    // the URLs a spec-following client asks for. Each document is registered
    // at both forms, the inserted segment and the appended one, so a client
    // that follows either derivation for either document finds it: the two
    // forms the derivations do not yield are asked for anyway. All serve
    // the same augmented document. The two issuer-suffixed paths resolve
    // here because these registrations run before the `/auth/*` catch-all
    // mounts.
    //
    // The bare-root `/.well-known/oauth-authorization-server` and
    // `/.well-known/openid-configuration` are deliberately absent, and a
    // request to either is a plain 404. Per RFC 8414 §3 those paths belong to
    // an issuer of `<base>` with no path component, which this server is not,
    // so answering there would serve a document whose `issuer` could not
    // match what the client asked about, and a client holding the wrong
    // issuer would meet a server-shaped error. A 404 names its own cause.
    app.get("/.well-known/oauth-authorization-server/auth", (c) =>
      augmentMetadata(authServerMeta, c.req.raw),
    );
    app.get("/.well-known/openid-configuration/auth", (c) =>
      augmentMetadata(openidConfigMeta, c.req.raw),
    );
    app.get("/auth/.well-known/openid-configuration", (c) =>
      augmentMetadata(openidConfigMeta, c.req.raw),
    );
    app.get("/auth/.well-known/oauth-authorization-server", (c) =>
      augmentMetadata(authServerMeta, c.req.raw),
    );
    // RFC 9728: the resource-server metadata a bearer challenge points at.
    app.route("/", oauthProtectedResourceRoutes(config));
  }

  // Protected routes
  app.route("/items", itemRoutes(storage));
  app.route("/items", bulkRoutes(storage));
  app.route("/items", bulkGetRoutes(storage));
  app.route("/items", itemsLookupRoutes(storage));
  app.route("/items", extensionRoutes(storage));
  app.route("/items", itemEdgeListingRoutes(storage));
  app.route("/edges", edgeRoutes(storage));
  app.route("/edges", edgesBulkRoutes(storage));
  app.route("/edge-types", edgeTypeRoutes(storage));
  app.route("/types", typeRoutes(storage));
  app.route("/search", searchRoutes(storage));
  app.route("/occurrences", occurrenceRoutes(storage));
  app.route("/metadata", metadataRoutes(storage));
  app.route("/blobs", blobRoutes(storage, blobs, housekeeping, config));
  app.route("/housekeeping", housekeepingRoutes(housekeeping));
  app.route("/connectors", connectorRoutes(storage));
  app.route("/connectors", connectorStateRoutes(storage, config));
  app.route("/folders", folderRoutes(storage));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/config", configRoutes(storage, instanceId));
  app.route(
    "/admin",
    adminArchiveRoutes(storage, blobs, { maxRowBytes: bulkBodyCap(config) }),
  );
  app.route("/admin", adminPlatformTypeRoutes(storage));
  // The owner door creates the account on the sign-in surface, so it is
  // served exactly when that surface is.
  if (auth) app.route("/owner", ownerRoutes(storage, auth));
  app.route("/export", exportRoutes(storage, blobs, instanceId));
  app.route("/auth", authRoutes(storage, auth));
  // `/auth/authorize` consent page (the @better-auth/oauth-provider plugin's
  // `consentPage` redirect target). Mounted BEFORE the better-auth catch-all
  // so this explicit GET handler wins over the plugin's own endpoints under
  // /auth/oauth2/*.
  app.route("/auth", authConsentRoutes({ storage, auth }));
  // The plugin's management endpoints — consent rows, clients, the resource
  // registry — answer 404 here before the catch-all can serve them. Marfa's
  // own routes are the only writers of a grant's two records; the reasoning
  // and the list are in `routes/oauth-plugin-fence.ts`, and a test holds the
  // list to what the plugin registers.
  app.route("/auth", oauthPluginFenceRoutes());

  // Marfa-owned /auth/error page. The @better-auth/oauth-provider plugin
  // redirects unrecoverable authorize failures here (e.g. invalid_client from
  // a stale client_id); without this explicit route the better-auth core
  // handler 302s to the API root JSON in production. Mounted before the
  // catch-all so this GET wins.
  app.route("/auth", authErrorRoutes());

  // Better-auth catch-all for unmatched /auth/* paths (sign-in, session,
  // plus the oauth-provider plugin's /auth/oauth2/* endpoints). Hono dispatches in registration
  // order — the explicit routes above win.
  if (auth) {
    const authInstance = auth;
    app.on(["POST", "GET"], "/auth/*", (c) => {
      // The one door of the library's that the document publishes. It takes
      // its request in the body, so a query key on it is a mistake like on
      // any other door.
      if (c.req.method === "POST" && c.req.path === "/auth/oauth2/register") {
        refuseUndeclaredKeysOf(c.req.url, []);
      }
      return authInstance.handler(c.req.raw, c.var.clientIp ?? null);
    });
  }

  app.route(
    "/events",
    eventRoutes(storage, {
      readView: { instanceId, signingKey: readViewKey },
      maxViewers: config.sseMaxViewers ?? 0,
    }),
  );
  app.route(
    "/webhooks",
    webhookRoutes(storage, {
      allowPrivateAddresses: config.webhookAllowPrivateAddresses ?? false,
    }),
  );
  app.route("/audit", auditRoutes(storage));
  app.route("/metrics", metricsRoutes(storage));
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
  // This document describes what this process serves, which is what a
  // client reading it at runtime needs. The committed spec is generated
  // from the same shaping and is what CI holds the source to.
  const openapiDocument = finalizeOpenAPISpec(
    app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  );
  app.get("/openapi.json", refuseUndeclaredQueryKeys([]), (c) =>
    c.json(openapiDocument),
  );

  // The auth instance rides on the app so the test harness can reach the
  // programmatic account seam (`createEmailAccount`) without rebuilding a
  // second Better Auth instance against the same database.
  return Object.assign(app, { auth });
}
