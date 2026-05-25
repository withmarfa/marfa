/**
 * Integration registry — workstream 3 Layer 2 PR 1.
 *
 * Persists Integration manifests as `system.integration` items so that:
 *   - `system.connection.integration.integration_ref` resolves
 *     to a stable item id at runtime (replacing WS2's inline-manifest path
 *     in routes/inbound-webhooks.ts and routes/connection-leased-tokens.ts —
 *     PR 2 of Layer 2 swaps those reads to the registry).
 *   - The install pipeline (this file's GET/POST /integrations/:id/install)
 *     can mint a connection bound to a specific manifest version.
 *
 * Sibling-per-version model — registering the same manifest_name at a new
 * manifest_version creates a new sibling item rather than mutating the
 * existing one. Connections installed against v1.0 keep pointing at the
 * v1.0 item even after v1.1 lands; upgrade is an explicit Layer 3 concern.
 *
 * Registration is platform-credential gated (is_platform: true) — the
 * marketplace publisher (or the orchestrator's CLI) is the legitimate
 * caller. Listing/get is admin-or-platform.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { resolveTenantIdForAuthUser } from "../auth/oauth-provider.js";
import { validateManifest } from "../integrations/validate-manifest.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { renderInstallConsentScreen } from "./integration-install-page.js";
import { performInstall } from "../connections/install-pipeline.js";
import { publish } from "../pubsub.js";

// Manifest is stored as opaque on the wire — `validateManifest()` runs
// the structured Zod check at the route handler.
const RegisterIntegrationRequestSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
});

const IntegrationItemSchema = z.object({
  id: z.string(),
  manifest_name: z.string(),
  manifest_version: z.string(),
  publisher: z.string(),
  summary: z.string().optional(),
  direction: z.enum(["read", "write", "both"]),
  runtime_compatibility: z.array(z.string()),
  registered_at: z.string(),
  manifest: z.record(z.string(), z.unknown()),
});

const IntegrationListResponseSchema = z.object({
  data: z.array(IntegrationItemSchema),
});

const registerRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Integrations"],
  summary: "Register an integration manifest",
  description:
    "Registers an integration manifest as a `system.integration` item. One row per `(manifest_name, manifest_version)` pair; subsequent versions register as sibling items, not edits. The manifest is validated against `IntegrationManifestSchema` — declared triggers, OAuth requirements, webhook verification method, target types, permissions.\n\nOnce registered, the manifest is installable into any tenant via `POST /integrations/{id}/install` (consent flow) or `POST /connections/install` (server-side admin install). See [Integrations](/concepts/integrations) and [Marketplace](/concepts/marketplace).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: RegisterIntegrationRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: IntegrationItemSchema } },
      description:
        "Integration registered. Subsequent versions register as sibling items.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Validation error (manifest schema rejection)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller lacks is_platform: true",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "manifest_name + manifest_version already registered",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Integrations"],
  summary: "List integrations",
  description:
    "Returns every registered integration manifest. Filter by `manifest_name` to enumerate versions of one integration. Each row carries the manifest contents, publisher metadata, and registration timestamps — use to render a marketplace surface or pick a version to install.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      manifest_name: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: IntegrationListResponseSchema },
      },
      description: "List of registered Integrations",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Integrations"],
  summary: "Get an integration",
  description:
    "Returns one integration manifest by id. The full manifest body is included — triggers, OAuth requirements, webhook verification, target types, permissions, bidirectional handling. Use as the source-of-truth payload at install time so the consent screen renders the actual scopes the user is approving.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: IntegrationItemSchema } },
      description: "The Integration item",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["integration_not_found"]),
        },
      },
      description: "Not found",
    },
  },
});

interface IntegrationProperties {
  manifest_name: string;
  manifest_version: string;
  publisher: string;
  summary?: string;
  direction: "read" | "write" | "both";
  runtime_compatibility: string[];
  manifest: Record<string, unknown>;
  registered_at: string;
}

function toResponse(item: {
  id: string;
  properties: Record<string, unknown>;
}): z.infer<typeof IntegrationItemSchema> {
  const props = item.properties as unknown as IntegrationProperties;
  return {
    id: item.id,
    manifest_name: props.manifest_name,
    manifest_version: props.manifest_version,
    publisher: props.publisher,
    summary: props.summary,
    direction: props.direction,
    runtime_compatibility: props.runtime_compatibility,
    registered_at: props.registered_at,
    manifest: props.manifest,
  };
}

export function integrationRoutes(
  storage: Storage,
  salt: string,
  auth?: MarfaAuth,
) {
  // Two routers mounted at the same prefix:
  //   - `apiRouter` carries the OpenAPI-registered JSON CRUD surface.
  //   - `htmlRouter` carries the HTML consent/install flow (plain Hono,
  //     not OpenAPI — the response is HTML, not JSON, so the OpenAPI
  //     spec doesn't describe it; same precedent as routes/auth-pages.ts'
  //     /authorize handlers).
  // Mixing OpenAPI routes and plain Hono routes on a single
  // OpenAPIHono instance was observed to cause Hono's body parser to
  // misroute requests during testing — splitting keeps each surface's
  // request lifecycle clean.
  const apiRouter = createOpenAPIRouter<AppEnv>();
  const htmlRouter = new Hono<AppEnv>();

  apiRouter.openapi(registerRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Integration registration requires a platform credential (is_platform: true)",
      );
    }

    const body = c.req.valid("json");
    const result = validateManifest(body.manifest);
    if (!result.ok) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Manifest validation failed",
        { errors: result.errors },
      );
    }
    const manifest = result.manifest;

    // Sibling-per-version uniqueness — manifest_name + manifest_version is
    // the dedupe key per tenant. The items list filter keeps the check
    // cheap; a future PR could promote it to a partial unique index if
    // registration volume grows.
    // Use the filter grammar in @withmarfa/shared (ParseFilter) — `eq` is
    // the equality operator, not `=`.
    const existing = await storage.items.list({
      tenantId: apiKey.tenant_id,
      type: "system.integration",
      filter: `properties.manifest_name eq "${manifest.name}" AND properties.manifest_version eq "${manifest.version}"`,
      limit: 1,
    });
    if (existing.data.length > 0) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Integration ${manifest.name}@${manifest.version} is already registered`,
        {
          manifest_name: manifest.name,
          manifest_version: manifest.version,
        },
      );
    }

    const now = new Date().toISOString();
    const properties: IntegrationProperties = {
      manifest_name: manifest.name,
      manifest_version: manifest.version,
      publisher: manifest.publisher,
      summary: manifest.description,
      direction: manifest.direction,
      runtime_compatibility: manifest.runtime_compatibility,
      manifest: manifest as unknown as Record<string, unknown>,
      registered_at: now,
    };
    const item = await storage.items.create(
      {
        type: "system.integration",
        properties: properties as unknown as Record<string, unknown>,
      },
      apiKey.tenant_id,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: apiKey.id,
      action: "integration.register",
      resource_type: "item",
      resource_id: item.id,
      details: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
      },
    });

    return c.json(toResponse(item), 201);
  });

  apiRouter.openapi(listRoute, async (c) => {
    const apiKey = requireAuth(c);
    const query = c.req.valid("query");
    const filter = query.manifest_name
      ? `properties.manifest_name eq "${query.manifest_name}"`
      : undefined;
    // The integration catalogue is the marketplace surface — manifests
    // are registered by platform credentials (is_platform: true), which
    // carry `tenant_id: null`. The default tenant-equality fence on
    // `items.list` would hide every such row from in-tenant callers,
    // so opt this catalogue read into the platform-scoped widening.
    // The flag is local to catalogue list endpoints; the generic
    // /items route and other tenant-scoped reads remain strictly
    // equality-fenced.
    const items = await storage.items.list({
      tenantId: apiKey.tenant_id,
      includePlatformScoped: true,
      type: "system.integration",
      filter,
      limit: query.limit ?? 50,
    });
    return c.json({ data: items.data.map((i) => toResponse(i)) }, 200);
  });

  apiRouter.openapi(getRoute, async (c) => {
    const apiKey = requireAuth(c);
    const id = c.req.valid("param").id;
    // Catalogue manifests are platform-scoped (tenant_id IS NULL) — opt
    // into the widening so tenant members can resolve them. The
    // type-check on the next line stays as the authoritative gate; only
    // genuine `system.integration` items pass.
    const item = await storage.items.get(id, apiKey.tenant_id, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    return c.json(toResponse(item), 200);
  });

  // ---------------------------------------------------------------------
  // Install pipeline — separate from the registry routes so the consent
  // surface (HTML) stays distinct from the registry CRUD surface (JSON).
  //
  // The install routes are NOT openapi-registered — they're plain Hono
  // routes returning HTML. This mirrors the precedent set by the OAuth
  // consent flow (routes/consent.ts) which also stays out of the
  // OpenAPI surface because the response is an HTML form, not JSON.
  //
  // Dual auth path (browser session OR Bearer): the install consent
  // screen is designed for human navigation, so a BetterAuth session
  // cookie is sufficient. Operator / test / CLI callers still go via a
  // Bearer-resolved api_key. `resolveInstallCaller` returns the caller's
  // tenant scope + an apiKeyId for the audit trail, or a Response on
  // unauthenticated browser navigations (302 to sign-in), or throws
  // 401 when an `Authorization` header was presented but didn't
  // resolve (the API-client failure shape).
  // ---------------------------------------------------------------------

  interface InstallCaller {
    /** Stable id for the audit trail. For Bearer callers: the api_keys
     *  row id. For session callers: `auth_user:<userId>` so operator
     *  queries can recognise session-backed installs. */
    apiKeyId: string;
    /** Tenant scope — `undefined` for platform-admin Bearer callers,
     *  the user's tenant for session callers, the key's tenant for
     *  ordinary Bearer callers. */
    tenantId: string | undefined;
  }

  async function resolveInstallCaller(
    c: Context<AppEnv>,
  ): Promise<InstallCaller | Response> {
    // Bearer path wins when present — preserves the existing test +
    // operator paths verbatim (no behavioural change for Authorization-
    // header callers).
    const apiKey = c.get("apiKey");
    if (apiKey) {
      return { apiKeyId: apiKey.id, tenantId: apiKey.tenant_id };
    }
    // Session path — browser navigation with a cookie but no Bearer.
    if (auth) {
      const session = await auth.getSession(c.req.raw.headers);
      if (session) {
        const tenantId = await resolveTenantIdForAuthUser(
          storage,
          session.user.id,
        );
        return {
          apiKeyId: `auth_user:${session.user.id}`,
          tenantId,
        };
      }
    }
    // Unauthenticated. Two shapes:
    //   - Authorization header sent but bearer middleware rejected it
    //     → 401 (API-client failure shape; the bug-report's
    //     "still returns 401" negative test).
    //   - No Authorization header → browser navigation; redirect to
    //     /auth/sign-in with the install URL preserved as `return_to`
    //     so the user lands back on the consent screen after signing
    //     in.
    if (c.req.header("authorization")) {
      throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
    }
    const url = new URL(c.req.url);
    const returnTo = `${url.pathname}${url.search}`;
    return c.redirect(
      `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
      302,
    );
  }

  htmlRouter.get("/:id/install", async (c) => {
    const caller = await resolveInstallCaller(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    // Catalogue manifests are platform-scoped — widen the lookup. See
    // the JSON `getRoute` handler above for the same pattern.
    const item = await storage.items.get(id, caller.tenantId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    // Optional `?credential_ref=<id>` pre-arm — when present, validate
    // it resolves to a same-tenant `system.credential` of `kind:
    // oauth_token` (the same constraints the install pipeline enforces)
    // before passing it through to the renderer as a hidden form
    // field. Validating here keeps the POST surface unchanged and
    // surfaces a clean 4xx if the operator wired a bad reference,
    // rather than letting the install proceed and failing deep in
    // OAuth start. NOT widened to `includePlatformScoped: true` —
    // credentials are tenant-scoped by design (see the credentials
    // route docstring); cross-tenant reuse is explicitly not supported.
    const credentialRefParam = c.req.query("credential_ref");
    let credentialRefHint: string | undefined;
    let credentialRefLabel: string | undefined;
    if (credentialRefParam !== undefined && credentialRefParam.length > 0) {
      const cred = await storage.items.get(credentialRefParam, caller.tenantId);
      if (cred?.type !== "system.credential") {
        throw new MarfaError(
          ErrorCode.INVALID_REQUEST,
          `credential_ref ${credentialRefParam} does not resolve to a system.credential item in this tenant`,
          { credential_ref: credentialRefParam },
        );
      }
      const credProps = cred.properties as { kind?: string; label?: string };
      if (credProps.kind !== "oauth_token") {
        throw new MarfaError(
          ErrorCode.INVALID_REQUEST,
          `credential_ref ${credentialRefParam} resolves to a system.credential of kind '${String(credProps.kind)}'; expected 'oauth_token'`,
          { credential_ref: credentialRefParam, kind: credProps.kind },
        );
      }
      credentialRefHint = cred.id;
      credentialRefLabel = credProps.label ?? cred.id;
    }

    const html = renderInstallConsentScreen({
      integrationId: id,
      manifestName: props.manifest_name,
      manifestVersion: props.manifest_version,
      publisher: props.publisher,
      summary: props.summary ?? "",
      direction: props.direction,
      manifest: props.manifest,
      ...(credentialRefHint !== undefined ? { credentialRefHint } : {}),
      ...(credentialRefLabel !== undefined ? { credentialRefLabel } : {}),
    });
    return c.html(html);
  });

  htmlRouter.post("/:id/install", async (c) => {
    const caller = await resolveInstallCaller(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    // Catalogue manifests are platform-scoped — widen the lookup. See
    // the JSON `getRoute` handler above for the same pattern.
    const item = await storage.items.get(id, caller.tenantId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    // Form-encoded submission from the consent screen. `decision=approve`
    // proceeds; anything else (or absent) is treated as a denial and
    // returns a 200 explainer page.
    const formData = await c.req.parseBody();
    const decision = formData.decision;
    const labelOverride =
      typeof formData.label === "string" ? formData.label : "";
    // Optional credential_ref carried as a hidden form field — used when
    // the consent screen was pre-armed with an existing OAuth provider
    // credential to reuse (e.g. installing a second Google service onto
    // an account that already has google.calendar). When absent the
    // install pipeline behaves as today.
    const credentialRefOverride =
      typeof formData.credential_ref === "string" &&
      formData.credential_ref.length > 0
        ? formData.credential_ref
        : undefined;

    if (decision !== "approve") {
      return c.html(renderDeniedPage());
    }

    const installed = await performInstall(storage, salt, {
      apiKeyId: caller.apiKeyId,
      tenantId: caller.tenantId,
      clientIp: c.get("clientIp") ?? null,
      integrationItemId: id,
      manifest: props.manifest,
      label:
        labelOverride.trim() ||
        `${props.manifest_name} ${props.manifest_version}`,
      ...(credentialRefOverride !== undefined
        ? { credentialRef: credentialRefOverride }
        : {}),
    });

    // Publish a `created` event for the new system.connection so the
    // reactive-run bridge's cache-invalidation subscriber picks it up.
    // Same fix as the JSON install route at routes/connections.ts —
    // both routes call the same install-pipeline, both need to feed
    // pubsub for the bridge to fan out to newly-installed connectors.
    const connection = await storage.items.get(
      installed.connection_id,
      caller.tenantId ?? undefined,
    );
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({
        type: "created",
        item: connection,
        metadata,
        tenantId: caller.tenantId ?? undefined,
      });
    }

    return c.html(renderInstalledPage(installed));
  });

  // Mount the HTML router on the API router so callers see one
  // mountable handler. apiRouter.route() forwards unmatched paths into
  // htmlRouter; OpenAPI registration on apiRouter is unaffected.
  apiRouter.route("/", htmlRouter);

  return apiRouter;
}

function renderDeniedPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Install denied</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px}</style>
</head><body><h1>Install denied</h1><p>No connection was created.</p></body></html>`;
}

function renderInstalledPage(installed: {
  connection_id: string;
  credential_id: string;
  activity_id: string;
}): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Installed</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px}
code{background:#eef2ff;padding:1px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}
dt{color:#6b7280}</style></head>
<body><h1>Connection installed</h1>
<dl>
  <dt>Connection</dt><dd><code>${escape(installed.connection_id)}</code></dd>
  <dt>Credential</dt><dd><code>${escape(installed.credential_id)}</code></dd>
  <dt>Activity</dt><dd><code>${escape(installed.activity_id)}</code></dd>
</dl>
<p>The runtime can now refresh credentials via the broker.</p>
</body></html>`;
}
