import { readEffectiveConfig } from "./effective-config.js";
import { profileRoutes } from "./routes/profile.js";
import {
  instanceDescriptionRoute,
  InstanceDescriptionSchema,
} from "./routes/instance-description.js";
import type { z } from "@hono/zod-openapi";
import { oauthRegistrationRoute } from "./routes/oauth-registration-schema.js";
import { ConnectorProblemsSchema } from "./routes/_connector-problems.js";
import { requireSecureOwnerTransport } from "./auth/owner-browser.js";
import { controlRoutes } from "./control/routes.js";
import { testRoutes } from "./control/test-routes.js";
import { setupRoutes } from "./routes/setup.js";
import { ownerPages } from "./routes/owner-pages.js";
import { directAuthorityMiddleware } from "./middleware/direct-authority.js";
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
import type { Context } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { copyReadBoundary, invalidReachRequest } from "./middleware/reach.js";
import { deriveKey, SECRET_INFO } from "./crypto/derive-key.js";
import { authMiddleware, hashApiKey } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { Storage } from "./storage/interface.js";
import type { BlobLayer } from "./storage/blob-layer.js";
import type { MarfaAuth } from "./auth/instance.js";
import { createMarfaAuth } from "./auth/instance.js";
import { ownerTrashRoutes } from "./routes/owner-trash.js";
import { itemSummaryRoutes } from "./routes/item-summaries.js";
import { itemRoutes } from "./routes/items.js";
import { readInstanceName } from "./instance-name.js";
import { renderRootPage } from "./routes/root-page.js";
import { CONSOLE_PAGES, type ConsolePages } from "./routes/console.js";
import { ownerBrowserSession } from "./routes/console-gate.js";
import { homeSearchQuery, renderHomePage } from "./routes/home-page.js";
import { setNoStore } from "./routes/no-store.js";
import { withPreparedHeaders } from "./prepared-headers.js";
import {
  consoleContentSecurityPolicy,
  pageSecurityPolicy,
} from "./routes/content-security-policy.js";
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
import { folderStatusRoutes } from "./routes/folder-status.js";
import { folderInventoryRoutes } from "./routes/folder-inventory.js";
import { folderRoutes } from "./routes/folders.js";
import {
  VIEW_SCHEMAS_DESCRIBED_BY_REFERENCE,
  viewRoutes,
} from "./routes/views.js";
import type { Housekeeping } from "./housekeeping/scheduler.js";
import { keyRoutes } from "./routes/keys.js";
import { exportRoutes } from "./routes/export.js";
import { restoreArchiveRoutes } from "./routes/restore-archive.js";
import { DEFAULT_UPLOAD_IDLE_TIMEOUT_MS } from "./upload-body.js";
import { platformTypeRoutes } from "./routes/platform-types.js";
import { ownerRoutes } from "./routes/owner.js";
import { authRoutes } from "./routes/auth-pages.js";
import { confirmRoutes } from "./routes/auth-confirm.js";
import { refuseUnservedLibraryPath } from "./routes/auth-fence.js";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { authStaticRoutes } from "./routes/auth-static.js";
import { isApprovedWebOrigin } from "./auth/web-origins.js";
import { OPEN_TO_EVERY_ORIGIN, openMethodsFor } from "./routes/_open-origin.js";
import { renderHttpErrorPage, prefersHtml } from "./routes/http-error-page.js";
import { extensionRoutes } from "./routes/extensions.js";
import { eventRoutes } from "./routes/events.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { auditRoutes } from "./routes/audit.js";
import { metricsRoutes } from "./routes/metrics.js";
import { configRoutes } from "./routes/config.js";
import { DESCRIBED_ONLY_BY_REFERENCE } from "./routes/_schemas.js";
import { ITEM_SCHEMAS_DESCRIBED_BY_REFERENCE } from "./routes/items.js";
import { TYPE_SCHEMAS_DESCRIBED_BY_REFERENCE } from "./routes/types.js";
import { BULK_ACTION_SCHEMAS_DESCRIBED_BY_REFERENCE } from "./bulk-actions/types.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import {
  INSTANCE_HEADER,
  instanceHeaderMiddleware,
} from "./middleware/instance-header.js";
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
import {
  bodyCapFor,
  bulkBodyCap,
  CONNECTOR_STATE_BODY_CAP,
  REGISTRATION_BODY_CAP,
} from "./middleware/body-cap.js";
import { jsonBodyGuard } from "./middleware/json-body.js";
import { servedContractVersion } from "./contract.js";
import { contractHeader } from "./middleware/contract-header.js";
import {
  idempotencyMiddleware,
  IDEMPOTENT_WRITE_DOORS,
} from "./middleware/idempotency.js";
import { healthRoutes, instanceReadCaller } from "./routes/health.js";
import { storageProbes } from "./routes/health-probes.js";
import { readAttention } from "./attention.js";
import { attentionRoutes } from "./routes/attention.js";
import { consoleHealth } from "./routes/console-health.js";
import {
  refuseUndeclaredKeysOf,
  refuseUndeclaredQueryKeys,
} from "./middleware/undeclared-query-keys.js";

/** The two doors that take a setup code or a handoff and count guesses themselves. */
const GUESS_LIMITED_SETUP_PATHS: ReadonlySet<string> = new Set([
  "/setup/exchange",
  "/setup/claim",
]);

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
   * The identity remains stable while display configuration can change.
   * Resolving it at boot and handing it to each identity door keeps their
   * answers equal without relying on separate reads of the stored row.
   */
  instanceId: string,
  options: {
    localAuthority?: boolean;
    /** The pages Home lists. Defaults to the console's own; a test passes its own. */
    consolePages?: ConsolePages;
  } = {},
) {
  // The empty string is the one wrong value the type cannot refuse, and it
  // is what a caller reaching for a field that is not there hands over. An
  // instance serving `"instance_id": ""` names nothing, and does it with a
  // 200 on three doors — loud here beats quiet everywhere.
  if (instanceId === "") {
    throw new Error("createApp: instanceId is empty; resolve it first");
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

  const app = new OpenAPIHono<AppEnv>();
  const reachKey = deriveKey(config.authSecret, SECRET_INFO.reach);
  const readBoundary = copyReadBoundary(storage, instanceId, reachKey);

  // Global error handler. Held in a variable because the idempotency
  // middleware renders a thrown error through this same handler rather
  // than re-deriving what it produces — a stored body that is nearly the
  // one that went out is worse than storing nothing.
  const errorHandler = createErrorHandler({
    reportingEnabled: async () =>
      (await readEffectiveConfig(storage.settings, config))
        .error_reporting_enabled,
    errorWebhookUrl: config.errorWebhookUrl,
    errorWebhookTimeoutMs: config.errorWebhookTimeoutMs,
    deploymentEnvironment: config.deploymentEnvironment,
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
    if (c.req.method === "GET" && c.req.header("X-Marfa-Reach") !== undefined)
      throw invalidReachRequest(
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
      return c.html(renderHttpErrorPage(404, c.var.cspNonce), 404);
    }
    return c.json(body, 404);
  });

  // The policy for every page the server renders. First, so that no answer
  // can precede it, a refusal from any middleware below included. Its own
  // middleware and not an option of `secureHeaders`, which writes after the
  // handler and would replace the policy the blob doors send for the bytes
  // they serve.
  app.use("*", pageSecurityPolicy);

  // Next out, so every answer the application gives carries the contract
  // version, the ones no later layer shapes included.
  app.use("*", contractHeader());

  // The root answers a page or the description by what the caller asks for,
  // so a cache must not hand one the other's: a refusal included.
  app.use("*", async (c, next) => {
    await next();
    if (
      c.req.path === "/" &&
      (c.req.method === "GET" || c.req.method === "HEAD")
    ) {
      c.res.headers.append("Vary", "Accept");
    }
  });

  // Expose the resolved AppConfig on the request context so handlers and
  // middleware read env-derived values from the single config source
  // rather than re-reading `process.env`.
  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("copyReadBoundary", readBoundary);
    await next();
  });

  // Structured logging (wraps entire request lifecycle)
  app.use(
    "*",
    loggerMiddleware(options.localAuthority ? "local_socket" : "http"),
  );

  // After the logger, so its refusal carries `X-Request-ID` like any other.
  app.use("*", async (c, next) => {
    if (
      c.req.method === "GET" &&
      c.req.header("X-Marfa-Reach") !== undefined &&
      !/^(?:\/items(?:\/[^/]+(?:\/edges)?)?|\/edges(?:\/[^/]+)?|\/types|\/edge-types|\/keys\/current|\/events)\/?$/.test(
        c.req.path,
      )
    )
      throw invalidReachRequest(
        "This door does not support conditional copy reads",
      );
    await next();
  });

  // Stamp request_id / key_id onto the active OTel span and
  // mark 5xx as span errors. Pure no-op when OpenTelemetry is disabled
  // (no active span). After the logger so `requestId` is already set.
  app.use("*", otelCorrelationMiddleware());

  // CORS: the origins `CORS_ORIGINS` names, and the address of every web
  // page the owner approved (`auth/web-origins.ts`). Beside a configured
  // origin, and outside production, any localhost or 127.0.0.1 origin is also
  // reflected, so the local dev loop works without listing every port; an
  // instance that names no origin reflects none, and a production server
  // can't be coerced into echoing an attacker-controlled
  // `http://localhost:<port>`.
  //
  // The discovery documents and registration answer every origin
  // (`routes/_open-origin.ts`), so a page that is not yet approved can find
  // the endpoints and register before it opens the approval window.
  //
  // A refused origin gets no `Access-Control-Allow-Origin` at all. A request
  // with no `Origin` is no browser's cross-origin request and skips the layer,
  // but its answer still says it varies by `Origin`, so a cache never hands
  // it to a page on another origin.
  const reflectLocalhost =
    !config.isProduction && config.corsOrigins.length > 0;
  // The server's own pages post from here, and a same-origin request needs
  // no answer from this layer, so it never pays for the read of approvals.
  const issuerOrigin = new URL(config.authBaseUrl).origin;
  const allowedOrigin = async (origin: string): Promise<string | null> => {
    if (config.corsOrigins.includes(origin)) return origin;
    if (origin === issuerOrigin) return null;
    if (reflectLocalhost) {
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return origin;
        }
      } catch {
        // invalid origin, ignore
      }
    }
    return (await isApprovedWebOrigin(storage, origin)) ? origin : null;
  };
  const corsLayer = cors({
    exposeHeaders: [...EXPOSED_RESPONSE_HEADERS],
    origin: allowedOrigin,
  });
  const openLayer = cors({
    exposeHeaders: [...EXPOSED_RESPONSE_HEADERS],
    origin: "*",
    allowMethods: (_origin, c) => [
      ...(OPEN_TO_EVERY_ORIGIN.get(c.req.path) ?? []),
    ],
    allowHeaders: ["Content-Type"],
  });
  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      if (c.req.header("origin") === undefined) {
        await next();
        c.header("Vary", "Origin", { append: true });
        return;
      }
      const open = openMethodsFor(
        c.req.method,
        c.req.path,
        c.req.header("access-control-request-method"),
      );
      return open === undefined ? corsLayer(c, next) : openLayer(c, next);
    }),
  );

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
  const connectorStateBodyLimit = bodyLimit({
    maxSize: CONNECTOR_STATE_BODY_CAP,
    onError: tooLarge,
  });
  const registrationBodyLimit = bodyLimit({
    maxSize: REGISTRATION_BODY_CAP,
    onError: tooLarge,
  });
  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const cap = bodyCapFor(c.req.path);
      if (cap === "none" || cap === "inbound" || cap === "picture")
        return next();
      if (cap === "bulk") return bulkBodyLimit(c, next);
      if (cap === "connector-state") return connectorStateBodyLimit(c, next);
      if (cap === "registration") return registrationBodyLimit(c, next);
      return requestBodyLimit(c, next);
    }),
  );
  // A write naming an instance has its body's depth and text judged after the
  // instance, so another instance refuses it for that alone
  // (`instance/write-instance-order`). On a protected door, they still precede
  // a missing credential refusal.
  const namesInstance = (c: Context<AppEnv>) =>
    c.req.header(INSTANCE_HEADER) !== undefined &&
    !/^\/auth(?:\/|$)/.test(c.req.path);
  app.use(
    "*",
    createMiddleware<AppEnv>((c, next) =>
      namesInstance(c) ? next() : jsonBodyGuard(c, next),
    ),
  );

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
    "restore",
    "connectors",
    "inbound_webhooks",
  ];
  // The deployed `version` and the `release` come from `version.json`,
  // read with the settings at boot; `contract` is the contract version,
  // which does not move on a deploy.
  const deployedVersion = config.versionSha ?? "dev";
  // `instance_id` names the deployment, and the root is where a caller that
  // holds no credential can read it: the id is what distinguishes two
  // instances answering the same shape, which is exactly the question
  // somebody pointing a client at an address is asking.
  app.openAPIRegistry.registerPath(instanceDescriptionRoute);
  const consolePages = options.consolePages ?? CONSOLE_PAGES;
  const probes = storageProbes(storage, {
    sqlitePath: config.sqlitePath,
    blobPath: config.blobPath,
  });
  const health = consoleHealth({
    storage,
    blobs,
    config,
    probes,
    housekeeping,
  });
  app.get("/", async (c) => {
    const wantsPage = prefersHtml(c.req.header("accept"));
    // The owner's browser may search Home; nobody else sends the root a query.
    const owner =
      wantsPage && auth
        ? await ownerBrowserSession(storage, auth, c.req.raw.headers)
        : null;
    refuseUndeclaredKeysOf(c.req.url, owner ? ["q"] : []);
    const instanceName = await readInstanceName(storage.settings);
    // One address, two readers: a program takes the description and a person
    // opening it in a browser takes a page.
    if (wantsPage) {
      // The page says who is signed in, so it is the person's own and is not
      // kept.
      setNoStore(c);
      if (!owner) return c.html(renderRootPage(c.var.cspNonce, instanceName));
      c.header(
        "Content-Security-Policy",
        consoleContentSecurityPolicy(c.var.cspNonce),
      );
      return c.html(
        renderHomePage({
          nonce: c.var.cspNonce,
          instanceName,
          address: new URL(config.authBaseUrl).host,
          registry: consolePages.registry,
          reading: await consolePages.read({
            storage,
            config,
            auth,
            health,
            attention: () => readAttention(storage, health),
          }),
          query: homeSearchQuery(c.req.query("q")),
        }),
      );
    }
    const description: z.infer<typeof InstanceDescriptionSchema> = {
      name: instanceName,
      version: deployedVersion,
      ...(config.releaseVersion !== undefined && {
        release: config.releaseVersion,
      }),
      instance_id: instanceId,
      contract: servedContractVersion(),
      features,
    };
    return c.json(description);
  });
  // Ahead of the credential and the limiter, as the probe of a container
  // must be. Detailed diagnostics check instance.read independently.
  app.route(
    "/health",
    healthRoutes(storage, blobs, config, probes, async (c) => {
      if (options.localAuthority) return true;
      const authorization = c.req.header("authorization");
      try {
        if (authorization !== undefined) {
          if (authorization.startsWith("Bearer marfa_at_")) {
            const token = await storage.oauthProvider?.validateAccessToken(
              hashApiKey(
                authorization.slice("Bearer marfa_at_".length),
                config.apiKeySalt,
              ),
            );
            return (
              token?.userId !== null &&
              token?.scopes.includes("instance.read") === true
            );
          }
          return await instanceReadCaller(
            storage,
            config.apiKeySalt,
          )(authorization);
        }
        if (auth) requireSecureOwnerTransport(auth);
        const session = await auth?.getSession(c.req.raw.headers, {
          readOnly: true,
        });
        return (
          session !== null &&
          session !== undefined &&
          (await storage.owner?.find())?.id === session.user.id
        );
      } catch {
        return false;
      }
    }),
  );

  // The page system's stylesheet and script. Public — anyone landing on `/auth/sign-in`
  // must be able to fetch the CSS without a session cookie. Mounted BEFORE
  // authMiddleware AND before the better-auth catch-all so
  // `/auth/static/*` resolves to the static handler rather than
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
  app.use(
    "*",
    directAuthorityMiddleware(
      storage,
      auth,
      config.authBaseUrl,
      options.localAuthority,
    ),
  );

  // Rate limiting (defaults: 1000 req/min, configurable via RATE_LIMIT_REQUESTS,
  // RATE_LIMIT_WINDOW_MS and RATE_LIMIT_KEYS_REQUESTS). Protects every door
  // mounted below it; the root, `/health`, `/auth/static` and `/inbound`
  // sit above it, and `openapi-finalize.ts` declares the root that way. Configuration
  // flows through AppConfig: the rate-limit middleware reads its settings
  // from there rather than from `process.env`, so a deployment's limits are
  // whatever `loadConfig` resolved at boot.
  if (config.rateLimitEnabled && !options.localAuthority) {
    const requestLimiter = rateLimitMiddleware({
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
        "/auth/confirm": 30,
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
    });
    app.use(
      "*",
      createMiddleware<AppEnv>((c, next) => {
        // The doors that take a setup code or handoff, and `POST /owner`,
        // have their own durable guessing limit, and a valid handoff is not
        // a guess. The setup page and the owner's steps under `/setup/` have
        // none, so this limiter keeps them.
        if (
          GUESS_LIMITED_SETUP_PATHS.has(c.req.path) ||
          (c.req.path === "/owner" && c.req.method === "POST")
        )
          return next();
        return requestLimiter(c, next);
      }),
    );
  }

  // Ahead of the idempotency claim, so a write refused for naming another
  // instance is never recorded under its key and replayed.
  app.use("*", instanceHeaderMiddleware(instanceId));
  app.use(
    "*",
    createMiddleware<AppEnv>((c, next) =>
      namesInstance(c) ? jsonBodyGuard(c, next) : next(),
    ),
  );

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
      // Registration refuses assertion authentication because this instance
      // has no assertion replay store; discovery must describe the same set.
      const confidentialMethods = ["client_secret_basic", "client_secret_post"];
      const clientMethods = ["none", ...confidentialMethods];
      payload.token_endpoint_auth_methods_supported = clientMethods;
      payload.revocation_endpoint_auth_methods_supported = clientMethods;
      payload.introspection_endpoint_auth_methods_supported =
        confidentialMethods;
      delete payload.token_endpoint_auth_signing_alg_values_supported;
      delete payload.revocation_endpoint_auth_signing_alg_values_supported;
      delete payload.introspection_endpoint_auth_signing_alg_values_supported;
      // Marfa extension: advertise the named permission bundles so clients
      // can render / request the bundled consent without hard-coding the
      // scope grammar. Non-standard field; OIDC/OAuth RPs ignore it.
      // The provider finds the apps to notify of a browser session's end
      // through the tokens bound to it, and an app's tokens are stored with no
      // session, so no app is told. Saying so keeps the document honest.
      payload.backchannel_logout_supported = false;
      payload.backchannel_logout_session_supported = false;
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
  app.route("/", ownerTrashRoutes(storage, config));
  app.route("/items", itemSummaryRoutes(storage));
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
  app.route("/folders", folderInventoryRoutes(storage));
  app.route("/attention", attentionRoutes(storage, health));
  app.route("/folders", folderRoutes(storage));
  app.route("/folders", folderStatusRoutes(storage));
  app.route("/views", viewRoutes(storage));
  app.route("/keys", keyRoutes(storage, config.apiKeySalt));
  app.route("/config", configRoutes(storage, instanceId, config));
  app.route(
    "/restore",
    restoreArchiveRoutes(storage, blobs, {
      maxRowBytes: bulkBodyCap(config),
      diskReserveBytes: config.diskReserveBytes,
      uploadIdleTimeoutMs:
        config.uploadIdleTimeoutMs ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS,
    }),
  );
  app.route("/platform-types", platformTypeRoutes(storage));
  // The owner door creates the account on the sign-in surface, so it is
  // served exactly when that surface is.
  if (auth) {
    app.route("/owner", ownerRoutes(storage, auth));
    app.route("/profile", profileRoutes(storage));
    app.route("/setup", setupRoutes(storage, auth));
    if (options.localAuthority)
      app.route("/_control", controlRoutes(storage, auth, config.authBaseUrl));
    app.route("/auth/owner", ownerPages(storage, auth, { config, health }));
  }
  // The harness's clock and fault routes: on the private socket alone, and
  // only when the instance was started for testing.
  if (options.localAuthority && config.testHooks)
    app.route(
      "/_control/test",
      testRoutes(() => housekeeping.names()),
    );
  app.route(
    "/export",
    exportRoutes(
      storage,
      blobs,
      instanceId,
      config.diskReserveBytes ?? 0,
      bulkBodyCap(config),
    ),
  );
  if (auth) app.route("/auth", confirmRoutes(storage, auth));
  app.route("/auth", authRoutes(storage, auth));
  // `/auth/authorize` consent page (the @better-auth/oauth-provider plugin's
  // `consentPage` redirect target). Mounted BEFORE the better-auth catch-all
  // so this explicit GET handler wins over the plugin's own endpoints under
  // /auth/oauth2/*.
  app.route("/auth", authConsentRoutes({ storage, auth }));

  // Marfa-owned /auth/error page. The @better-auth/oauth-provider plugin
  // redirects unrecoverable authorize failures here (e.g. invalid_client from
  // a stale client_id); without this explicit route the better-auth core
  // handler 302s to the API root JSON in production. Mounted before the
  // catch-all so this GET wins.
  app.route("/auth", authErrorRoutes());

  // Better-auth catch-all for unmatched /auth/* paths (sign-in, session,
  // plus the oauth-provider plugin's /auth/oauth2/* endpoints). Hono dispatches in registration
  // order — the explicit routes above win. Only the library routes Marfa
  // serves reach it; every other path answers 404 (`routes/auth-fence.ts`).
  if (auth) {
    const authInstance = auth;
    if (auth.registration)
      app.openAPIRegistry.registerPath(
        oauthRegistrationRoute(auth.registration),
      );
    app.on(["POST", "GET"], "/auth/*", async (c) => {
      refuseUnservedLibraryPath(new URL(c.req.url).pathname);
      // The one door of the library's that the document publishes. It takes
      // its request in the body, so a query key on it is a mistake like on
      // any other door.
      if (c.req.method === "POST" && c.req.path === "/auth/oauth2/register") {
        refuseUndeclaredKeysOf(c.req.url, []);
        // Any origin may register, so a browser session's cookie, which a
        // page on another origin can send along, must not reach the library:
        // with one it would refuse the post for its origin, or register the
        // client to the signed-in person with what that unlocks.
        const headers = new Headers(c.req.raw.headers);
        headers.delete("cookie");
        return withPreparedHeaders(
          c,
          await authInstance.handler(
            new Request(c.req.raw, { headers }),
            c.var.clientIp ?? null,
          ),
        );
      }
      return authInstance.handler(c.req.raw, c.var.clientIp ?? null);
    });
  }

  app.route(
    "/events",
    eventRoutes(storage, {
      reach: { instanceId, signingKey: reachKey },
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
  for (const [name, schema] of Object.entries({
    ...DESCRIBED_ONLY_BY_REFERENCE,
    ...ITEM_SCHEMAS_DESCRIBED_BY_REFERENCE,
    ...TYPE_SCHEMAS_DESCRIBED_BY_REFERENCE,
    ConnectorProblems: ConnectorProblemsSchema,
    ...BULK_ACTION_SCHEMAS_DESCRIBED_BY_REFERENCE,
    ...VIEW_SCHEMAS_DESCRIBED_BY_REFERENCE,
  })) {
    app.openAPIRegistry.register(name, schema);
  }
  app.openAPIRegistry.registerComponent("securitySchemes", "ownerSession", {
    type: "apiKey",
    in: "cookie",
    name: "marfa.auth.session_token",
    description:
      "The owner's browser sign-in. Writes require this instance's Origin; sensitive changes require actual authentication within five minutes. Apps cannot use this authority.",
  });
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
      info: {
        ...OPENAPI_DOCUMENT_INFO,
        version: String(servedContractVersion()),
      },
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
