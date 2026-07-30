/**
 * Integration registry.
 *
 * Persists Integration manifests as `system.integration` items so that:
 *   - `system.connection.integration.integration_ref` resolves
 *     to a stable item id at runtime (replacing the older inline-manifest
 *     path in routes/inbound-webhooks.ts and routes/connection-leased-tokens.ts).
 *   - The install pipeline (this file's GET/POST /integrations/:id/install)
 *     can mint a connection bound to a specific manifest version.
 *
 * Sibling-per-version model — registering the same manifest_name at a new
 * manifest_version creates a new sibling item rather than mutating the
 * existing one. Connections installed against v1.0 keep pointing at the
 * v1.0 item even after v1.1 lands; upgrade is an explicit caller concern.
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
import { resolveSpaceIdForAuthUser } from "../auth/oauth-provider.js";
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
  operationId: "registerIntegration",
  method: "post",
  path: "/",
  tags: ["Integrations"],
  summary: "Register an integration manifest",
  description:
    "Registers an integration manifest as a `system.integration` item, validating it before the write. One row per `(manifest_name, manifest_version)` pair — registering a new version creates a sibling item rather than editing the existing one.",
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
  operationId: "listIntegrations",
  method: "get",
  path: "/",
  tags: ["Integrations"],
  summary: "List integrations",
  description:
    "Returns every registered integration manifest. Filter by `manifest_name` to enumerate the registered versions of one integration.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      manifest_name: z
        .string()
        .optional()
        .describe("Filter to versions of a single integration by name."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of integrations to return."),
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
  operationId: "getIntegration",
  method: "get",
  path: "/{id}",
  tags: ["Integrations"],
  summary: "Get an integration",
  description:
    "Returns one integration manifest by id, including the full manifest body. Use as the source-of-truth payload at install time so the consent screen renders the actual scopes being approved.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().min(1).describe("Id of the integration to fetch."),
    }),
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
  // Split: apiRouter (OpenAPI JSON CRUD) and htmlRouter (HTML install flow, plain Hono).
  // Mixing the two on one OpenAPIHono instance was observed to misroute bodies in tests.
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

    const existing = await storage.items.list({
      spaceId: apiKey.space_id,
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
      manifest: manifest,
      registered_at: now,
    };
    const item = await storage.items.create(
      {
        type: "system.integration",
        properties: properties as unknown as Record<string, unknown>,
      },
      apiKey.space_id,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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
    // Platform-scoped manifests (space_id IS NULL) are invisible to in-space callers without this flag.
    const items = await storage.items.list({
      spaceId: apiKey.space_id,
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
    // Platform-scoped manifests (space_id IS NULL) — widen so space members can resolve them.
    const item = await storage.items.get(id, apiKey.space_id, {
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
  // space scope + an apiKeyId for the audit trail, or a Response on
  // unauthenticated browser navigations (302 to sign-in), or throws
  // 401 when an `Authorization` header was presented but didn't
  // resolve (the API-client failure shape).
  // ---------------------------------------------------------------------

  interface InstallCaller {
    /** Stable id for the audit trail. For Bearer callers: the api_keys
     *  row id. For session callers: `auth_user:<userId>` so operator
     *  queries can recognize session-backed installs. */
    apiKeyId: string;
    /** Space scope — `undefined` for platform-admin Bearer callers,
     *  the user's space for session callers, the key's space for
     *  ordinary Bearer callers. */
    spaceId: string | undefined;
  }

  async function resolveInstallCaller(
    c: Context<AppEnv>,
  ): Promise<InstallCaller | Response> {
    const apiKey = c.get("apiKey");
    if (apiKey) {
      return { apiKeyId: apiKey.id, spaceId: apiKey.space_id };
    }
    if (auth) {
      const session = await auth.getSession(c.req.raw.headers);
      if (session) {
        const spaceId = await resolveSpaceIdForAuthUser(
          storage,
          session.user.id,
        );
        return {
          apiKeyId: `auth_user:${session.user.id}`,
          spaceId,
        };
      }
    }
    // Authorization header rejected → 401. No header → redirect to sign-in with return_to.
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
    const item = await storage.items.get(id, caller.spaceId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    // ?credential_ref= pre-arm: validate the credential before rendering so the
    // operator gets a clean 4xx rather than a deep install failure.
    const credentialRefParam = c.req.query("credential_ref");
    let credentialRefHint: string | undefined;
    let credentialRefLabel: string | undefined;
    if (credentialRefParam !== undefined && credentialRefParam.length > 0) {
      const cred = await storage.items.get(credentialRefParam, caller.spaceId);
      if (cred?.type !== "system.credential") {
        throw new MarfaError(
          ErrorCode.INVALID_REQUEST,
          `credential_ref ${credentialRefParam} does not resolve to a system.credential item in this space`,
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
    const item = await storage.items.get(id, caller.spaceId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    const formData = await c.req.parseBody();
    const decision = formData.decision;
    const labelOverride =
      typeof formData.label === "string" ? formData.label : "";
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
      spaceId: caller.spaceId,
      authMode: c.get("config").authMode,
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

    // Same pubsub publish as the JSON install route — the bridge needs it to discover new connections.
    const connection = await storage.items.get(
      installed.connection_id,
      caller.spaceId ?? undefined,
    );
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({
        type: "created",
        item: connection,
        metadata,
        spaceId: caller.spaceId ?? undefined,
      });
    }

    return c.html(renderInstalledPage(installed));
  });

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
