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
 *   - `POST /credentials/api-token` — `kind: "api_token"`.
 *     Carries an upstream service's API base URL + a user-supplied
 *     bearer token. For integrations whose upstream uses a static API
 *     token rather than OAuth (Todoist, Readwise, Raindrop, …). No
 *     refresh primitive — the proxy stamps the bearer verbatim and
 *     surfaces 401s as `action_required` activity for operator reauth.
 *
 *   - `DELETE /credentials/{id}` — removes a credential and the secret
 *     it holds. Refuses while a live connection still references it, so
 *     removal cannot silently break a working integration.
 *
 * The resulting credential id is passed as `credential_ref` on
 * subsequent `POST /connections/install` calls. Multiple integrations
 * sharing an upstream (e.g. `google/calendar` + `google/tasks`) share
 * one credential row.
 *
 * Companion read paths:
 *   - `routes/oauth-callback.ts:readAuthorizeConfig` — `oauth_token`
 *     only; mints the authorize URL and exchanges the code.
 *   - `routes/connection-proxy.ts:readCredentialConfig` — both kinds;
 *     reads the upstream URL + decrypts the bearer / refreshes tokens.
 *
 * Auth: `requireAuth` plus `space.credentials` — a space sets up its own
 * provider credentials. The route calls `storage.items.create` directly,
 * which bypasses the `POST /items` `is_operator` gate on `system.*`
 * writes; the permission on these routes is the access-control boundary.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  findLiveCredentialDependents,
  purgeCredential,
} from "../connections/upstream-credential.js";

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
   * route.
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
 * params, multi-header schemes) remains a future extension.
 *
 * No Zod default is applied — the field is genuinely optional on the
 * wire. The proxy's read path defaults to `Bearer` when the field is
 * absent.
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

const DeleteCredentialResponseSchema = z.object({
  ok: z.literal(true),
  credential_id: z.string(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const createOAuthProviderCredentialRoute = createRoute({
  operationId: "createOAuthProviderCredential",
  method: "post",
  path: "/oauth-provider",
  tags: ["Credentials"],
  summary: "Create an OAuth provider credential",
  description:
    "Creates a `system.credential` of `kind: oauth_token` holding an upstream service's OAuth client config, with the client secret encrypted at rest. The returned credential id is passed as `credential_ref` on subsequent `POST /connections/install` calls; the credential is space-scoped and cannot be reused across spaces.",
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
      description: "Caller does not hold `space.credentials`.",
    },
  },
});

const deleteCredentialRoute = createRoute({
  operationId: "deleteCredential",
  method: "delete",
  path: "/{id}",
  tags: ["Credentials"],
  summary: "Delete a credential",
  description:
    "Removes a `system.credential` and the secret it holds. This is a hard delete: the encrypted secret is gone, not orphaned. Refuses with `credential_in_use` while any connection that is not revoked still references the credential — uninstall those connections first. `system.*` types carry the bounded `active | revoked` lifecycle, which the generic transition endpoint cannot express, so credential removal has its own route rather than going through `POST /items/{id}/transition`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: DeleteCredentialResponseSchema },
      },
      description: "Credential removed along with the secret it held.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Malformed credential id.",
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
      description: "Caller does not hold `space.credentials`.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "No credential with that id in the caller's space.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["credential_in_use"]),
        },
      },
      description:
        "A live connection still references this credential. The response names them.",
    },
  },
});

const createApiTokenCredentialRoute = createRoute({
  operationId: "createApiTokenCredential",
  method: "post",
  path: "/api-token",
  tags: ["Credentials"],
  summary: "Create a static API-token credential",
  description:
    "Creates a space-scoped `system.credential` of `kind: api_token` holding an upstream's base URL plus a static bearer token (encrypted at rest), for integrations that use a static token rather than OAuth. There is no refresh primitive — when the upstream rejects the token, the proxy surfaces the 401 and emits an `action_required` activity prompting reinstall with a fresh token.",
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
      description: "Caller does not hold `space.credentials`.",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function credentialRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(createOAuthProviderCredentialRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.credentials");
    const body = c.req.valid("json");

    // Encryption failures propagate as 500 — a missing MARFA_SECRET_KEY is a server-config bug, not a caller bug.
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
      key.space_id ?? undefined,
    );

    void storage.audit.log({
      key_id: key.id,
      client_ip: c.get("clientIp") ?? null,
      space_id: key.space_id ?? null,
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
    const key = requireAuth(c);
    requireSpacePermission(c, "space.credentials");
    const body = c.req.valid("json");

    const secret_encrypted = encryptSecret(
      body.api_token,
      SECRET_INFO.connectionOauthToken,
    );

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
      key.space_id ?? undefined,
    );

    void storage.audit.log({
      key_id: key.id,
      client_ip: c.get("clientIp") ?? null,
      space_id: key.space_id ?? null,
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

  r.openapi(deleteCredentialRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.credentials");
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid credential ID");
    }
    const spaceId = key.space_id ?? undefined;

    const credential = await storage.items.get(id, spaceId);
    if (credential?.type !== "system.credential") {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Credential not found");
    }

    // Refuse rather than cascade. Taking a working integration down as a
    // side effect of tidying up a credential is the more surprising of
    // the two behaviours, and the caller can always uninstall first.
    //
    // Shared with the uninstall pipeline, which asks the same question
    // from the other side. Two copies of "is anything still using this"
    // is how one of them ends up never being asked.
    const dependents = await findLiveCredentialDependents(storage, id, {
      spaceId,
    });
    if (dependents.length > 0) {
      throw new MarfaError(
        ErrorCode.CREDENTIAL_IN_USE,
        `Credential ${id} is referenced by ${String(dependents.length)} connection(s) that are not revoked. Uninstall them first.`,
        { connection_ids: dependents },
      );
    }

    await purgeCredential(storage, credential, spaceId);

    void storage.audit.log({
      key_id: key.id,
      client_ip: c.get("clientIp") ?? null,
      space_id: key.space_id ?? null,
      action: "credential.delete",
      resource_type: "item",
      resource_id: id,
      details: {
        label: (credential.properties as { label?: unknown } | undefined)
          ?.label,
        kind: (credential.properties as { kind?: unknown } | undefined)?.kind,
      },
    });

    return c.json({ ok: true as const, credential_id: id }, 200);
  });

  return r;
}
