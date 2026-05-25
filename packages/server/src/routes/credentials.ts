/**
 * Credential-management routes — admin surface for creating the
 * `system.credential` rows that integrations reference.
 *
 * Two routes, one per non-runtime credential kind:
 *
 *   - `POST /credentials/oauth-provider` — `kind: "oauth_token"`.
 *     Carries an upstream service's OAuth client config (authorize/
 *     token URLs, client_id, encrypted client_secret, optional default
 *     scope, upstream base URL).
 *
 *   - `POST /credentials/api-token` (T-241) — `kind: "api_token"`.
 *     Carries an upstream service's API base URL + a user-supplied
 *     bearer token. For integrations whose upstream uses a static API
 *     token rather than OAuth (Todoist, Readwise, Raindrop, …). No
 *     refresh primitive — the proxy stamps the bearer verbatim and
 *     surfaces 401s as `action_required` activity for operator reauth.
 *
 * The resulting credential id is passed as `credential_ref` on
 * subsequent `POST /connections/install` calls. Multiple integrations
 * sharing an upstream (e.g. `google.calendar` + `google.tasks`) share
 * one credential row.
 *
 * Companion read paths:
 *   - `routes/oauth-callback.ts:readAuthorizeConfig` — `oauth_token`
 *     only; mints the authorize URL and exchanges the code.
 *   - `routes/connection-proxy.ts:readCredentialConfig` — both kinds;
 *     reads the upstream URL + decrypts the bearer / refreshes tokens.
 *
 * Auth: `requireTenantAdmin` — tenant admins set up their own provider
 * credentials. The route calls `storage.items.create` directly, which
 * bypasses the `POST /items` `is_platform` gate on `system.*` writes;
 * the admin-gated route surface is the access-control boundary.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth.js";
import { requireTenantAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OAuthProviderCredentialRequestSchema = z.object({
  label: z
    .string()
    .min(1, "label is required")
    .max(200, "label must be 200 characters or fewer"),
  oauth_authorize_url: z.url("oauth_authorize_url must be a URL").max(2048),
  oauth_token_url: z.url("oauth_token_url must be a URL").max(2048),
  oauth_client_id: z.string().min(1, "oauth_client_id is required").max(512),
  oauth_client_secret: z
    .string()
    .min(1, "oauth_client_secret is required")
    .max(2048),
  upstream_base_url: z.url("upstream_base_url must be a URL").max(2048),
  oauth_default_scope: z.string().max(2048).optional(),
  /**
   * Provider-specific authorize-URL hints stamped on every
   * `POST /connections/:id/oauth/start` for this credential — e.g.
   * `{ access_type: "offline", prompt: "consent" }` for Google to
   * guarantee a `refresh_token` on the code exchange. Merged with
   * (and overridden by) the caller's `extra_params` on the start
   * route. T-259.
   */
  authorize_extra_params: z
    .record(z.string().max(64), z.string().max(2048))
    .optional(),
});

const OAuthProviderCredentialResponseSchema = z.object({
  credential_id: z.string(),
});

/**
 * Auth-header schemes the proxy can stamp on `kind:api_token` calls.
 * Most modern APIs use `Bearer`; Readwise's REST API requires `Token`;
 * `Basic` is included for completeness. Anything more exotic (query
 * params, multi-header schemes) remains a future extension. T-246.
 *
 * No Zod default is applied — the field is genuinely optional on the
 * wire so an omitted body matches the T-241 PR1 credential shape on
 * disk (no `auth_scheme` field). The proxy's read path defaults to
 * `Bearer` when the field is absent.
 */
const ApiTokenAuthSchemeSchema = z.enum(["Bearer", "Token", "Basic"]);

const ApiTokenCredentialRequestSchema = z.object({
  label: z
    .string()
    .min(1, "label is required")
    .max(200, "label must be 200 characters or fewer"),
  upstream_base_url: z.url("upstream_base_url must be a URL").max(2048),
  api_token: z
    .string()
    .min(1, "api_token is required")
    .max(4096, "api_token must be 4096 characters or fewer"),
  /**
   * Optional HTTP Authorization scheme. Default `Bearer`. Set to
   * `Token` for Readwise; `Basic` for upstreams that present the
   * token as a basic-auth password. The proxy stamps
   * `Authorization: <scheme> <api_token>` verbatim — no encoding
   * applied (the operator pre-encodes if a Basic scheme needs it).
   */
  auth_scheme: ApiTokenAuthSchemeSchema.optional(),
});

const ApiTokenCredentialResponseSchema = z.object({
  credential_id: z.string(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const createOAuthProviderCredentialRoute = createRoute({
  method: "post",
  path: "/oauth-provider",
  tags: ["Credentials"],
  summary: "Create an OAuth provider credential",
  description:
    "Creates a `system.credential` of `kind: oauth_token` carrying an upstream service's OAuth client config — authorize URL, token URL, client_id, encrypted client_secret, upstream API base URL, and optional default scope. The resulting credential id is passed as `credential_ref` on subsequent `POST /connections/install` calls so multiple integrations of the same upstream (e.g. `google.calendar` + `google.tasks`) share one OAuth client and one stored secret instead of duplicating per-integration.\n\nThe client_secret is encrypted server-side under the `connectionOauthToken` HKDF domain (AES-256-GCM). Decryption only happens at the OAuth proxy + callback paths; the plaintext is never returned by any read path.\n\nTenant-scoped: the credential is created in the calling key's tenant, and integrations within that tenant can reference it. Cross-tenant reuse is not supported — each tenant brings its own OAuth provider config.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: OAuthProviderCredentialRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: OAuthProviderCredentialResponseSchema },
      },
      description:
        "Credential created. Returns the new credential's id for use as `credential_ref` on install.",
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
      description: "Invalid request body.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Authentication required.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not an admin or tenant_admin.",
    },
  },
});

const createApiTokenCredentialRoute = createRoute({
  method: "post",
  path: "/api-token",
  tags: ["Credentials"],
  summary: "Create a static API-token credential",
  description:
    "Creates a `system.credential` of `kind: api_token` carrying an upstream service's API base URL + the user-supplied bearer token (encrypted at rest). The resulting credential id is passed as `credential_ref` on subsequent `POST /connections/install` calls.\n\nFor integrations whose upstream uses a static bearer (Todoist, Readwise, Raindrop, etc) rather than the OAuth dance. The connection proxy stamps the bearer transparently on every call; there is no refresh primitive — when the upstream rejects the token (401), the proxy surfaces 401 and emits a `system.activity` of severity `action_required` asking the operator to reinstall with a fresh token.\n\nThe bearer is encrypted server-side under the `connectionOauthToken` HKDF domain (AES-256-GCM) — same encryption domain that protects OAuth client secrets and access/refresh tokens. The plaintext is never returned by any read path.\n\nTenant-scoped: the credential is created in the calling key's tenant.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: ApiTokenCredentialRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: ApiTokenCredentialResponseSchema },
      },
      description:
        "Credential created. Returns the new credential's id for use as `credential_ref` on install.",
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
      description: "Invalid request body.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Authentication required.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not an admin or tenant_admin.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function credentialRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(createOAuthProviderCredentialRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const body = c.req.valid("json");

    // Let encryption failures propagate as 500 — matches the pattern in
    // routes/oauth-callback.ts where the same call is unguarded. A failed
    // encrypt here is a server-config bug (missing MYME_SECRET_KEY), not a
    // user-input bug; surfacing 500 is the honest signal.
    const secret_encrypted = encryptSecret(
      body.oauth_client_secret,
      SECRET_INFO.connectionOauthToken,
    );

    const credential = await storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: body.label,
          kind: "oauth_token",
          oauth_provider_config: {
            oauth_authorize_url: body.oauth_authorize_url,
            oauth_token_url: body.oauth_token_url,
            oauth_client_id: body.oauth_client_id,
            upstream_base_url: body.upstream_base_url,
            ...(body.oauth_default_scope !== undefined
              ? { oauth_default_scope: body.oauth_default_scope }
              : {}),
            ...(body.authorize_extra_params !== undefined
              ? { authorize_extra_params: body.authorize_extra_params }
              : {}),
          },
          secret_encrypted,
        },
      },
      key.tenant_id ?? undefined,
    );

    void storage.audit.log({
      key_id: key.id,
      client_ip: c.get("clientIp") ?? null,
      tenant_id: key.tenant_id ?? null,
      action: "credential.oauth_provider.create",
      resource_type: "item",
      resource_id: credential.id,
      details: {
        label: body.label,
        oauth_client_id: body.oauth_client_id,
        upstream_base_url: body.upstream_base_url,
      },
    });

    return c.json({ credential_id: credential.id }, 201);
  });

  r.openapi(createApiTokenCredentialRoute, async (c) => {
    const key = requireTenantAdmin(c);
    const body = c.req.valid("json");

    // Same encryption domain as OAuth client secrets + access/refresh
    // tokens — keeps every connection-scoped secret under one HKDF tag
    // so rotating the master key sweeps everything at once.
    const secret_encrypted = encryptSecret(
      body.api_token,
      SECRET_INFO.connectionOauthToken,
    );

    // Persist `auth_scheme` only when explicitly supplied — a missing
    // field defaults to `Bearer` at proxy-read time. Keeps the shape
    // backward-compatible with the api_token credentials minted under
    // T-241 PR1 (no `auth_scheme` field on disk).
    const apiTokenConfig: Record<string, unknown> = {
      upstream_base_url: body.upstream_base_url,
    };
    if (body.auth_scheme !== undefined) {
      apiTokenConfig.auth_scheme = body.auth_scheme;
    }

    const credential = await storage.items.create(
      {
        type: "system.credential",
        properties: {
          label: body.label,
          kind: "api_token",
          api_token_config: apiTokenConfig,
          secret_encrypted,
        },
      },
      key.tenant_id ?? undefined,
    );

    // Never log the api_token plaintext — only its existence. The
    // upstream_base_url is non-secret (it's documented on the
    // integration's manifest); the label is operator-supplied.
    void storage.audit.log({
      key_id: key.id,
      client_ip: c.get("clientIp") ?? null,
      tenant_id: key.tenant_id ?? null,
      action: "credential.api_token.create",
      resource_type: "item",
      resource_id: credential.id,
      details: {
        label: body.label,
        upstream_base_url: body.upstream_base_url,
      },
    });

    return c.json({ credential_id: credential.id }, 201);
  });

  return r;
}
