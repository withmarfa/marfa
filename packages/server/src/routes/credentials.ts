/**
 * Credential-management routes — admin surface for creating the
 * `system.credential` rows that integrations reference.
 *
 * Today's only route: `POST /credentials/oauth-provider` — creates a
 * `system.credential` of `kind: "oauth_token"` carrying an upstream
 * service's OAuth client config (authorize/token URLs, client_id,
 * encrypted client_secret, optional default scope, upstream base URL).
 *
 * The resulting credential's id is intended to be passed as
 * `credential_ref` on subsequent `POST /connections/install` calls so
 * multiple integrations of the same upstream provider (e.g.
 * `google.calendar` + `google.tasks`) share one OAuth client and one
 * stored secret.
 *
 * Companion read paths that consume this row:
 *   - `routes/oauth-callback.ts:readAuthorizeConfig` — reads the
 *     provider config to mint the authorize URL and exchange the code.
 *   - `routes/connection-proxy.ts:readOAuthConfig` — reads the same
 *     provider config to refresh tokens at the proxy layer.
 *
 * Auth: `requireTenantAdmin` — tenant admins set up their own OAuth
 * providers. The route calls `storage.items.create` directly, which
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
});

const OAuthProviderCredentialResponseSchema = z.object({
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

  return r;
}
